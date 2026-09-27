"""Grounded Catalog extraction over a recipe's segmentation: result version 2 (grounded catalogue design §8).

One call per block — or per bounded window of an oversized block — sees the block's primary text between markers,
marked context, the headings in force and the glossary entries it uses, and returns candidates `{value, quote, key,
provenance}`. Code decides what is accepted: the quote must be text of the entry, the value must be readable off it
and conform to its field, and the field must be tied to the value by an explicit rule — the printed label or an
in-force heading (never asked of the model), or a recipe key that introduces the value. A quote-supported value
without such a rule is proposed for review; a failed check is rejected; neither enters the accepted record. Every
request is counted with the served model's tokenizer before it is sent and must fit the input budget.
"""
from __future__ import annotations

import hashlib
import re
import threading
import time
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from kei_exp.canonical import canonical_json
from kei_exp.kie.extract.evidence import Evidence, text_of
from kei_exp.kie.extract.llm import Chat
from kei_exp.kie.extract.locate import BlockText, forms, locate, normalise, raw_range
from kei_exp.kie.extract.models import ROLE, ROLES, Router, as_router
from kei_exp.kie.extract.method import CatalogFactors
from kei_exp.kie.extract.schema import Node, Schema, conform, json_schema, notes
from kei_exp.kie.extract.stages import Call, _complete, merge
from kei_exp.kie.model import Block, GlossaryEntry, Span
from kei_exp.kie.recipe import Recipe
from kei_exp.kie.segmentation import Segmentation

EXTRACTION_VERSION = 2
PROMPT_VERSION = 4  # Shared schema notes now show permitted labels in the model's instruction prompt.
BUDGET_VERSION = 1
NORMALIZATION_VERSION = 1        # verified glossary expansions beside accepted raw values; a change invalidates results
KEY_GAP = 3                      # at most this many non-alphanumeric characters between a key and its value
GLOSSARY_LINES = 40              # the glossary allowance: at most this many entries the block's text uses

GUARDRAIL = (
    "You extract structured data from one entry of a catalogue. Answer every field with null when the entry does "
    "not give it, or with an object: value (typed as the field), quote (the exact text of the entry the value is "
    "read from, copied character for character), key (the printed key word or abbreviation right before the value, "
    "such as Mbl., or null) and provenance (token when a key introduces the value, positional when its place in the "
    "entry says what it is). Use only the text between the ENTRY markers; headings, glossary and context are for "
    "orientation. Never invent a value. Return only the JSON object.")
ARBITRATION = (
    "Several candidate values were found in one catalogue entry for one field. Choose the candidate label whose "
    "value is correct for the field, given its snippet, or NONE when none is. Return only the JSON object.")
NONE = "NONE"
UNPROCESSED = {"budget_count_mismatch", "reply_malformed", "reply_missing_fields"}  # a call that did not do its work


class CatalogOptions(BaseModel):
    """`options.catalog`: the recipe that segments the source, and the per-call token budget."""
    model_config = ConfigDict(extra="forbid")
    recipe: str
    input_tokens: int = Field(default=4096, ge=64)   # a too-small budget is refused as schema_exceeds_budget
    output_tokens: int = Field(default=1024, ge=64)
    factors: CatalogFactors | None = None

    def enabled(self, factor: str) -> bool:
        return self.factors is None or getattr(self.factors, factor)


class Counter:  # the interface `kie.extract.tokens.TokenCounter` offers; a test may supply its own
    context_tokens: int | None
    probes: list[dict]                           # calibration requests it sent to the model while being obtained

    def request_tokens(self, system: str, user: str, schema: dict | None = None) -> int: ...
    def identity(self) -> dict: ...


@dataclass
class _Bindings:
    entry_label: list[Node]
    headings: dict[str, list[Node]]              # heading kind -> bound top-level fields
    keys: dict[str, list[str]]                   # top-level field name -> key tokens
    inactive: list[str]                          # recipe bindings naming fields this schema does not have
    effective: dict[str, str]                    # field name -> "entry_label" | heading kind


def bindings_for(schema: Schema, recipe: Recipe) -> _Bindings:
    fields = {node.name: node for node in schema.record_nodes}
    scalar = {name: node for name, node in fields.items() if node.type not in ("object", "array")}
    labels = [scalar[name] for name in recipe.bindings.entry_label if name in scalar]
    headings = {kind: [scalar[name] for name in names if name in scalar]
                for kind, names in recipe.bindings.headings.items()}
    keys = {name: tokens for name, tokens in recipe.bindings.keys.items() if name in scalar}
    named = {*recipe.bindings.entry_label, *(n for names in recipe.bindings.headings.values() for n in names),
             *recipe.bindings.keys}
    effective = {node.name: "entry_label" for node in labels}
    effective.update({node.name: kind for kind, nodes in headings.items() for node in nodes})
    return _Bindings(labels, headings, keys, sorted(name for name in named if name not in scalar), effective)


@dataclass
class _Outcome:
    kind: str                                    # accepted | proposed | rejected
    path: tuple
    value: Any
    spans: list[Span] = field(default_factory=list)
    alternatives: list[list[Span]] = field(default_factory=list)
    key_spans: list[Span] = field(default_factory=list)
    reason: str | None = None
    quote: str | None = None
    key: str | None = None
    provenance: str | None = None
    linked_by: str | None = None
    heading: str | None = None
    window: int = 0


@dataclass
class _Run:
    """What one extraction accumulates."""
    evidence: Evidence
    schema: Schema
    recipe: Recipe
    options: CatalogOptions
    chat: Router
    counters: dict[str, Counter]                 # role -> the counter of the server that role's calls go to
    calls: list[Call] = field(default_factory=list)
    issues: list[dict] = field(default_factory=list)
    refused: bool = False
    candidates: list[dict] = field(default_factory=list)

    def issue(self, code: str, detail: str, record: int | None = None, path: Sequence | None = None) -> None:
        self.issues.append({"code": code, "detail": detail, "record": record,
                            "path": list(path) if path is not None else None})

    def count(self, stage: str, system: str, user: str, schema: dict) -> int:
        """The input tokens of a `stage` request as the server that serves it will count them."""
        return self.counters[ROLE[stage]].request_tokens(system, user, schema)

    def call(self, stage: str, record: int | None, system: str, user: str, schema: dict) -> Any:
        """One counted call: refused before sending when over budget, compared with the served count after."""
        counted = self.count(stage, system, user, schema)
        if counted > self.options.input_tokens:
            self.issue("budget_refused", f"a {stage} request counts {counted} tokens, over the input budget of "
                       f"{self.options.input_tokens}", record)
            self.refused = True
            return None
        answer, attempts = _complete(self.chat, stage=stage, record=record, system=system, user=user, schema=schema,
                                     max_tokens=self.options.output_tokens)
        self.calls += attempts
        final = attempts[-1]
        if not final.ok:
            self.issue("call_failed", final.error or f"{stage} call failed", record)
        if final.input_tokens is not None and final.input_tokens != counted:
            self.issue("budget_count_mismatch", f"the server counted {final.input_tokens} input tokens where the "
                       f"tokenizer counted {counted}", record)
        if final.ok and not isinstance(answer, dict):  # readable JSON (null included) is not yet the requested object
            kind = "null" if answer is None else type(answer).__name__
            self.issue("reply_malformed", f"the {stage} reply is a JSON {kind}, not an object", record)
            return None
        if missing := [name for name in schema.get("required", []) if answer is not None and name not in answer]:
            self.issue("reply_missing_fields", f"the {stage} reply omits {', '.join(missing)}", record)
        return answer


def extract_grounded(evidence: Evidence, schema: Schema, recipe: Recipe, options: CatalogOptions,
                     segmentation: Segmentation, chat: Chat | Router, counter: Counter | dict[str, Counter], *,
                     chunks: int = 1, before_entry: Callable[[], None] | None = None) -> dict:
    """The version 2 artifact body for `schema` over `segmentation` (without run identity and fingerprint). `counter`
    is one counter for every call, or one per role when the roles are served apart.

    `chunks` contiguous runs of entries are extracted at once, each in its own thread with its own `_Run`, because
    `_Run.call` mutates run state; the segmentation, budget checks, bindings and document fields are computed once,
    and the chunks' records, calls and issues are merged back in entry order. `before_entry` is called before every
    entry, and what it raises ends the extraction."""
    if chunks < 1:
        raise ValueError("chunks must be at least 1")
    started, clock = datetime.now(UTC).isoformat(), time.monotonic()
    counters = counter if isinstance(counter, dict) else dict.fromkeys(ROLES, counter)
    distinct = list({id(each): each for each in counters.values()}.values())
    run = _Run(evidence, schema, recipe, options, as_router(chat), counters)
    run.calls += [Call(stage="tokenizer_probe", record=None, input_tokens=probe["input_tokens"],
                       output_tokens=probe["output_tokens"], seconds=probe["seconds"], finish=None, ok=True)
                  for each in distinct for probe in getattr(each, "probes", [])]
    bindings = bindings_for(schema, recipe)
    for each in distinct:
        if each.context_tokens is None:
            run.issue("budget_context_unknown", "the server reports no context size, so the budget cannot be shown "
                      "to fit it")
            run.refused = True
        elif options.input_tokens + options.output_tokens > each.context_tokens:
            run.issue("budget_exceeds_context", f"input {options.input_tokens} + output {options.output_tokens} "
                      f"tokens exceed the server's context of {each.context_tokens}")
            run.refused = True
    headings = {event.id: event for event in segmentation.heading_events}
    records: list[dict] = []
    outcomes: list[_Outcome] = []
    competitors: list[dict] = []
    if not run.refused and segmentation.blocks and _schema_alone(run, schema) > options.input_tokens:
        run.issue("schema_exceeds_budget", f"the instructions and schema alone count {_schema_alone(run, schema)} "
                  f"tokens, over the input budget of {options.input_tokens}; nothing was sent")
        run.refused = True
    pieces: list[list[tuple[int, Block]]] = []
    if not run.refused:
        document = _document(run)  # once for the whole document; every chunk's records merge it
        pieces = _pieces(list(enumerate(segmentation.blocks)), chunks)
        for part, found in _in_chunks(run, pieces, before_entry,
                                      lambda part, number, block: _block(part, number, block, headings, bindings,
                                                                         segmentation)):
            run.calls += part.calls        # chunk order is entry order: prelude calls, then each chunk's
            run.issues += part.issues
            run.refused = run.refused or part.refused
            run.candidates += part.candidates
            for record, block_outcomes, contest in found:
                outcomes += block_outcomes
                competitors += contest
                records.append(merge(record, document, evidence.source_name, schema))
    if not segmentation.blocks:
        run.issue("no_records", "the segmentation resolved no entry")
    accepted = [outcome for outcome in outcomes if outcome.kind == "accepted"]
    texts = {passage.id: passage for passage in (*evidence.passages, *evidence.withheld)}
    expansions = _expansions(segmentation.glossary) if options.enabled("glossary") else {}
    coverage = segmentation.coverage
    processing = (not run.refused and all(call.ok for call in run.calls) and not coverage.withheld_failures
                  and not any(issue["code"] in UNPROCESSED for issue in run.issues))
    completeness = {"processing": processing, "coverage": coverage.complete,
                    "grounding": options.enabled("verification") and all(outcome.spans for outcome in accepted),
                    "recall": "unmeasured"}
    return {
        "extraction_version": EXTRACTION_VERSION, "prompt_version": PROMPT_VERSION, "strategy": "catalog",
        "chunks": len(pieces),
        "started": started, "seconds": round(time.monotonic() - clock, 3),
        "segmentation": {"fingerprint": segmentation.fingerprint, "digest": segmentation.digest,
                         "recipe": {"id": recipe.id, "version": recipe.version,
                                    "structure_sha256": recipe.structure_sha256,
                                    "bindings_sha256": recipe.bindings_sha256},
                         "bindings": bindings.effective,
                         # alternative field names the recipe binds that this schema does not use: informational
                         "bindings_unmatched": bindings.inactive,
                         # what segmentation could not settle (reading order, numbering, glossary...), for review
                         "diagnostics": [{"code": d.code, "detail": d.detail, "block": d.block, "spans": _spans(d.spans)}
                                         for d in segmentation.diagnostics]},
        "budget": {"version": BUDGET_VERSION, "input_tokens": options.input_tokens,
                   "output_tokens": options.output_tokens, "tokenizer": counters["fields"].identity(),
                   "tokenizers": {role: each.identity() for role, each in counters.items()}},
        "normalization": {"version": NORMALIZATION_VERSION, "rules": ["glossary"] if options.enabled("glossary") else []},
        **({"method_version": 1, "raw_candidates": run.candidates} if options.factors is not None else {}),
        "records": records,
        "record_blocks": [{"block": block.id, "entry_label": block.entry_label} for block in segmentation.blocks],
        "evidence": [_link(outcome, texts, expansions) for outcome in accepted if outcome.spans],
        "proposed": [_item(outcome, texts) for outcome in outcomes if outcome.kind == "proposed"],
        "rejected": [_item(outcome, texts) for outcome in outcomes if outcome.kind == "rejected"],
        "competitors": competitors,
        "ungrounded": [], "unverified": [node.name for node in schema.document_nodes],
        "coverage": coverage.model_dump(mode="json"),
        "completeness": completeness,
        "complete": all(completeness[key] for key in ("processing", "coverage", "grounding")) and not run.issues,
        "issues": run.issues,
        "calls": [asdict(call) for call in run.calls],
        "tokens": {"input": _total(call.input_tokens for call in run.calls),
                   "output": _total(call.output_tokens for call in run.calls)},
    }


def fingerprint(body: dict, generation: str, digest: str, schema: Schema, options: dict, model: dict) -> str:
    """Over everything the artifact follows from: parse, schema, options, model, prompt, recipe, budget, tokenizer and
    the segmentation it was cut from."""
    return hashlib.sha256(canonical_json({
        "generation": generation, "digest": digest, "schema": schema.model_dump(by_alias=True, exclude_none=True),
        "options": options, "model": model, "prompt_version": PROMPT_VERSION,
        **({"method_version": body["method_version"]} if "method_version" in body else {}),
        "recipe": body["segmentation"]["recipe"], "segmentation": body["segmentation"]["fingerprint"],
        "budget": body["budget"], "normalization": body["normalization"]})).hexdigest()


def _pieces(entries: list, chunks: int) -> list[list]:
    """`entries` in at most `chunks` contiguous runs whose sizes differ by at most one; none is empty."""
    count = min(chunks, len(entries))
    bounds = [index * len(entries) // count for index in range(count + 1)] if count else []
    return [entries[bounds[index]:bounds[index + 1]] for index in range(count)]


def _in_chunks(prelude: _Run, pieces: list[list[tuple[int, Block]]], before_entry: Callable[[], None] | None,
               work: Callable[[_Run, int, Block], tuple]) -> list[tuple[_Run, list]]:
    """Each piece with its own `_Run`, one thread per piece when there are several. A failed piece stops the others
    at their next entry; the first failure in entry order is raised once every thread has returned."""
    halt = threading.Event()

    def one(piece):
        part = _Run(prelude.evidence, prelude.schema, prelude.recipe, prelude.options, prelude.chat, prelude.counters)
        found = []
        try:
            for number, block in piece:  # the document-wide entry number, so issues and calls name the record
                if halt.is_set():
                    break
                if before_entry is not None:
                    before_entry()
                found.append(work(part, number, block))
        except BaseException:
            halt.set()
            raise
        return part, found

    if len(pieces) <= 1:
        return [one(piece) for piece in pieces]
    with ThreadPoolExecutor(max_workers=len(pieces), thread_name_prefix="catalog-chunk") as pool:
        futures = [pool.submit(one, piece) for piece in pieces]
    for future in futures:
        if (error := future.exception()) is not None:
            raise error
    return [future.result() for future in futures]


# --- prompts and budget --------------------------------------------------------------------------------------------

def _system(schema: Schema, nodes: Sequence[Node], keys: dict[str, list[str]]) -> str:
    lines = [GUARDRAIL, f"A record is: {schema.record_description}", *notes(nodes)]
    lines += [f"- {name}: the value follows {' or '.join(tokens)}" for name, tokens in keys.items()
              if any(node.name == name for node in nodes)]
    return "\n".join(lines)


def _user(headings: list[str], glossary: list[str], before: list[str], entry: str, after: list[str]) -> str:
    parts = []
    if headings:
        parts.append("### Headings in force\n" + "\n".join(headings))
    if glossary:
        parts.append("### Glossary\n" + "\n".join(glossary))
    if before:
        parts.append("### Context before the entry\n" + "\n".join(before))
    parts.append(f"### ENTRY\n{entry}\n### END ENTRY")
    if after:
        parts.append("### Context after the entry\n" + "\n".join(after))
    return "\n\n".join(parts) + "\n\nReturn the JSON object now."


def _schema_alone(run: _Run, schema: Schema) -> int:
    nodes = schema.record_nodes
    return run.count("entry", _system(schema, nodes, bindings_for(schema, run.recipe).keys), _user([], [], [], "", []),
                     _candidates_schema(nodes))


@dataclass(frozen=True)
class _Unit:
    segment: str
    start: int
    end: int


def _units(block: Block, texts: dict[str, str]) -> list[_Unit]:
    """The block's primary text as source lines, each with its raw range."""
    units = []
    for span in block.primary_spans:
        position = span.start
        for raw in texts[span.segment_id][span.start:span.end].split("\n"):
            start, end = position + len(raw) - len(raw.lstrip()), position + len(raw.rstrip())
            if end > start:
                units.append(_Unit(span.segment_id, start, end))
            position += len(raw) + 1
    return units


def _windows(run: _Run, units: list[_Unit], texts: dict[str, str], fits) -> list[list[_Unit]] | None:
    """Consecutive units per window, each window's request within budget, one unit of overlap; a unit too long for
    any window is cut at whitespace, then at code points. None when not even one code point fits."""
    pieces: list[_Unit] = []
    for unit in units:
        pieces += _cut(unit, texts, fits)
    if any(piece is None for piece in pieces):
        return None
    windows: list[list[_Unit]] = []
    index = 0
    while index < len(pieces):
        window = [pieces[index]]
        while index + len(window) < len(pieces) and fits(window + [pieces[index + len(window)]]):
            window.append(pieces[index + len(window)])
        windows.append(window)
        index += len(window)
        if (run.options.enabled("overlap") and index < len(pieces) and len(window) > 1
                and fits([window[-1], pieces[index]])):
            index -= 1  # the last unit is seen again as the start of the next window
    return windows


def _cut(unit: _Unit, texts: dict[str, str], fits) -> list[_Unit | None]:
    if fits([unit]):
        return [unit]
    text = texts[unit.segment]
    pieces: list[_Unit | None] = []
    start = unit.start
    while start < unit.end:
        low, high, best = start + 1, unit.end, None
        while low <= high:  # the longest prefix from `start` that fits
            middle = (low + high) // 2
            if fits([_Unit(unit.segment, start, middle)]):
                best, low = middle, middle + 1
            else:
                high = middle - 1
        if best is None:
            return [None]
        end = best
        if best < unit.end and (space := text.rfind(" ", start + 1, best)) > start:
            end = space  # prefer a whitespace boundary
        pieces.append(_Unit(unit.segment, start, end))
        start = end
        while start < unit.end and text[start].isspace():
            start += 1
    return pieces


# --- one block -----------------------------------------------------------------------------------------------------

def _block(run: _Run, number: int, block: Block, headings: dict, bindings: _Bindings,
           segmentation: Segmentation) -> tuple[dict, list[_Outcome], list[dict]]:
    schema = run.schema
    texts = {p.id: p.text for p in (*run.evidence.passages, *run.evidence.withheld)}
    in_force = [headings[heading] for heading in block.heading_events] if run.options.enabled("headings") else []
    kinds = {event.kind: event for event in in_force}
    outcomes: list[_Outcome] = []
    record: dict[str, Any] = {}
    structural: set[str] = set()
    for node in bindings.entry_label:
        outcomes.append(_fitted(run, number, node, _label(number, node, block)))
        structural.add(node.name)
    for kind, nodes in bindings.headings.items():
        event = kinds.get(kind)
        for node in nodes:
            if event is not None:
                span = event.spans[0]
                value = texts[span.segment_id][span.start:span.end]
                outcomes.append(_fitted(run, number, node, _Outcome(
                    "accepted", ("records", number, node.name), value, spans=[span], provenance="inherited",
                    linked_by="structure", heading=event.id)))
                structural.add(node.name)
    for outcome in outcomes:
        if outcome.kind == "accepted":
            record[outcome.path[2]] = outcome.value
    nodes = [node for node in schema.record_nodes if node.name not in structural]
    if not nodes:
        return _record(schema, record), outcomes, []
    system = _system(schema, nodes, bindings.keys)
    reply_schema = _candidates_schema(nodes)
    units = _units(block, texts)
    entry_text = "\n".join(texts[u.segment][u.start:u.end] for u in units)
    glossary = [f"{entry.key} — {entry.expansion}" for entry in segmentation.glossary
                if run.options.enabled("glossary") and _bounded(entry.key, entry_text)][:GLOSSARY_LINES]
    heading_lines = [event.text for event in in_force]
    before, after = _context(block, texts, {p.id: n for n, p in enumerate(run.evidence.passages)})
    if not run.options.enabled("overlap"):
        before, after = [], []

    def fits(window, with_extras=False):
        user = _user(heading_lines, glossary if with_extras else [], before if with_extras else [],
                     "\n".join(texts[u.segment][u.start:u.end] for u in window), after if with_extras else [])
        return run.count("entry", system, user, reply_schema) <= run.options.input_tokens

    if fits(units, with_extras=True):
        windows, extras = [units], True
    else:
        windows, extras = _windows(run, units, texts, fits), False
        if windows is None:
            run.issue("window_refused", f"entry {block.entry_label} cannot be cut into windows that fit the budget",
                      number)
            run.refused = True
            return _record(schema, record), outcomes, []
    # Candidates are verified against the whole entry, never a window, so a cut cannot make a boundary the source lacks.
    view = BlockText.of([(u.segment, texts[u.segment], Span(segment_id=u.segment, start=u.start, end=u.end))
                         for u in units])
    found: list[_Outcome] = []
    for window_number, window in enumerate(windows):
        user = _user(heading_lines, glossary if extras else [], before if extras else [],
                     "\n".join(texts[u.segment][u.start:u.end] for u in window), after if extras else [])
        answer = run.call("entry", number, system, user, reply_schema)
        if not isinstance(answer, dict):
            continue
        if run.options.factors is not None:
            run.candidates.append({"record": number, "window": window_number, "fields": answer})
        for node in nodes:
            for outcome in _verify(("records", number, node.name), node, answer.get(node.name), view,
                                   bindings.keys.get(node.name), verify=run.options.enabled("verification")):
                outcome.window = window_number
                found.append(outcome)
    merged, contest = _merge(run, number, found, texts)
    outcomes += merged
    for outcome in merged:
        if outcome.kind == "accepted":
            _place(record, outcome.path[2:], outcome.value)
    return _record(schema, record), outcomes, contest


def _fitted(run: _Run, number: int, node: Node, outcome: _Outcome) -> _Outcome:
    """A structural value conformed to its field; one its type or allowed values refuse is rejected and reported,
    because the source has a value the schema cannot hold (the model is not asked instead: structure owns it)."""
    typed = _typed(outcome.value, node)
    if typed is None:
        outcome.kind, outcome.reason = "rejected", "type_mismatch"
        run.issue("binding_type_mismatch", f"{node.name}: the {outcome.provenance} value {outcome.value!r} does not "
                  f"fit a {node.type} field", number, outcome.path)
    else:
        outcome.value = typed
    return outcome


def _label(number: int, node: Node, block: Block) -> _Outcome:
    first = block.primary_spans[0]
    digits = re.match(r"\d+", block.entry_label)[0]
    numeric = node.type in ("integer", "number")
    shown = digits if numeric else block.entry_label
    value = block.entry_no if node.type == "integer" else float(block.entry_no) if numeric else block.entry_label
    # `_fitted` conforms it to the field, or rejects it
    return _Outcome("accepted", ("records", number, node.name), value,
                    spans=[Span(segment_id=first.segment_id, start=first.start, end=first.start + len(shown))],
                    provenance="positional", linked_by="structure")


def _context(block: Block, texts: dict[str, str], order: dict[str, int]) -> tuple[list[str], list[str]]:
    """The block's context split into what precedes and what follows it in reading order."""
    def position(span: Span) -> tuple[int, int]:
        return order.get(span.segment_id, -1), span.start
    first = position(block.primary_spans[0])
    before = [texts[s.segment_id][s.start:s.end] for s in block.context_spans if position(s) < first]
    after = [texts[s.segment_id][s.start:s.end] for s in block.context_spans if position(s) >= first]
    return before, after


def _bounded(key: str, text: str) -> list[int]:
    hay, needle = normalise(text).text, normalise(key).text
    return [m.start() for m in re.finditer(re.escape(needle), hay)
            if (m.start() == 0 or not hay[m.start() - 1].isalnum())
            and (m.end() == len(hay) or not hay[m.end()].isalnum() or not needle[-1].isalnum())]


def _candidates_schema(nodes: Sequence[Node]) -> dict:
    return {"type": "object", "properties": {node.name: _candidate_schema(node) for node in nodes},
            "required": [node.name for node in nodes], "additionalProperties": False}


def _leaf(node: Node) -> dict:
    value = json_schema([node])["properties"][node.name]
    return {"type": ["object", "null"], "properties": {
        "value": value, "quote": {"type": "string"}, "key": {"type": ["string", "null"]},
        "provenance": {"type": "string", "enum": ["token", "positional"]}},
        "required": ["value", "quote", "key", "provenance"], "additionalProperties": False}


def _candidate_schema(node: Node) -> dict:
    if node.type == "array" and node.item_type is not None:
        item = Node(id=f"{node.id}-item", name=node.name, type=node.item_type)
        return {"type": ["array", "null"], "items": _leaf(item)}
    if node.type == "array":
        return {"type": ["array", "null"], "items": _candidates_schema(node.children or [])}
    if node.type == "object":
        return {**_candidates_schema(node.children or []), "type": ["object", "null"]}
    return _leaf(node)


# --- verification --------------------------------------------------------------------------------------------------

def _typed(value: Any, node: Node) -> Any:
    """The value conformed to its field's type, or None when it cannot be."""
    kind = node.type if node.type != "array" else node.item_type
    if kind == "boolean" or isinstance(value, bool) or value is None:
        return value if kind == "boolean" and isinstance(value, bool) else None
    if kind == "integer":
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        return int(value) if isinstance(value, str) and value.strip().isdigit() else None
    if kind == "number":
        if isinstance(value, (int, float)):
            return value
        try:
            return float(str(value).replace(",", "."))
        except ValueError:
            return None
    text = str(value).strip() if isinstance(value, (str, int, float)) else ""
    if not text:
        return None
    if node.allowed_values is not None and text not in node.allowed_values:
        return None
    return text


def _verify(path: tuple, node: Node, answer: Any, view: BlockText, keys: list[str] | None, *,
            verify: bool = True) -> list[_Outcome]:
    if answer is None:
        return []
    if node.type == "object":
        if not isinstance(answer, dict):
            return [_Outcome("rejected", path, answer, reason="malformed_candidate")]
        return [outcome for child in node.children or []
                for outcome in _verify((*path, child.name), child, answer.get(child.name), view, None, verify=verify)]
    if node.type == "array":
        if not isinstance(answer, list):
            return [_Outcome("rejected", path, answer, reason="malformed_candidate")]
        if node.item_type is not None:
            item = Node(id=f"{node.id}-item", name=node.name, type=node.item_type)
            return [outcome for index, entry in enumerate(answer)
                    for outcome in _verify((*path, index), item, entry, view, None, verify=verify)]
        child = Node(id=f"{node.id}-object", name=node.name, type="object", children=node.children)
        return [outcome for index, entry in enumerate(answer)
                for outcome in _verify((*path, index), child, entry, view, None, verify=verify)]
    return [_scalar(path, node, answer, view, keys, verify=verify)]


def _scalar(path: tuple, node: Node, candidate: Any, view: BlockText, keys: list[str] | None, *,
            verify: bool = True) -> _Outcome:
    if not isinstance(candidate, dict):
        return _Outcome("rejected", path, candidate, reason="malformed_candidate")
    value, quote, key, provenance = (candidate.get(name) for name in ("value", "quote", "key", "provenance"))
    outcome = _Outcome("rejected", path, value, quote=quote if isinstance(quote, str) else None,
                       key=key if isinstance(key, str) else None,
                       provenance=provenance if provenance in ("token", "positional") else None)
    typed = _typed(value, node)
    if typed is None:
        outcome.reason = "type_mismatch"
        return outcome
    outcome.value = typed
    if not verify:
        outcome.kind, outcome.reason = "proposed", "verification_disabled"
        return outcome
    if not isinstance(quote, str) or not quote.strip():
        outcome.reason = "no_quote"
        return outcome
    quoted = locate(view, quote)
    if not quoted:
        outcome.reason = "quote_not_in_entry"
        return outcome
    if isinstance(typed, bool):  # a yes/no is read off its quote, never off a span, and no rule ties it to a field
        outcome.kind, outcome.spans, outcome.alternatives = "proposed", quoted[0], quoted[1:]
        return outcome
    numeric = isinstance(typed, (int, float))
    values = [found for spans in quoted for text in forms(typed)
              for found in locate(view, text, within=raw_range(view, spans), numeric=numeric)]
    if not values:
        outcome.reason = "value_not_in_quote"
        return outcome
    if keys:
        keyed = _after_keys(view, typed, keys)
        if not keyed:
            outcome.reason, outcome.spans = "key_context_missing", values[0]
            return outcome
        outcome.kind, outcome.linked_by, outcome.provenance = "accepted", "key", "token"  # a key introduces it
        outcome.spans, outcome.key_spans = keyed[0]
        outcome.alternatives = [spans for spans, _ in keyed[1:]]
        return outcome
    outcome.kind, outcome.spans, outcome.alternatives = "proposed", values[0], values[1:]
    return outcome


def _after_keys(view: BlockText, value: Any, keys: list[str]) -> list[tuple[list[Span], list[Span]]]:
    """Every place where one of the field's keys introduces the value, found in the entry itself rather than taken
    from the model's quote: (value spans, key spans)."""
    found = []
    for key in keys:
        for key_spans in locate(view, key):
            _, key_end = raw_range(view, key_spans)
            numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
            for text in forms(value):
                for spans in locate(view, text, within=(key_end, min(len(view.text), key_end + len(text) + KEY_GAP)),
                                    numeric=numeric):
                    start, _ = raw_range(view, spans)
                    if not any(char.isalnum() for char in view.text[key_end:start]):
                        found.append((spans, key_spans))
    return found


def _merge(run: _Run, number: int, found: list[_Outcome], texts: dict) -> tuple[list[_Outcome], list[dict]]:
    """One record's outcomes across windows: a value seen twice at one place is one value; accepted singular values
    that disagree are competitors, resolved only by an arbitration call over those candidates; array items are
    concatenated in window order without repeating a located item."""
    merged: list[_Outcome] = []
    contest: list[dict] = []
    singular: dict[tuple, list[_Outcome]] = {}
    seen_items: set[tuple] = set()
    counters: dict[tuple, int] = {}
    for outcome in found:
        if outcome.kind != "accepted":
            merged.append(outcome)
            continue
        array_at = next((position for position, step in enumerate(outcome.path) if isinstance(step, int)
                         and position > 1), None)
        if array_at is None:
            singular.setdefault(outcome.path, []).append(outcome)
            continue
        identity = (outcome.path[:array_at], tuple((s.segment_id, s.start, s.end) for s in outcome.spans),
                    outcome.path[array_at + 1:])
        if identity in seen_items:
            continue
        seen_items.add(identity)
        base = outcome.path[:array_at]
        key = (base, outcome.window, outcome.path[array_at])
        if key not in counters:
            counters[key] = sum(1 for k in counters if k[0] == base)
        outcome.path = (*base, counters[key], *outcome.path[array_at + 1:])
        merged.append(outcome)
    for path, candidates in singular.items():
        values: dict[str, list[_Outcome]] = {}
        for candidate in candidates:
            values.setdefault(repr(candidate.value), []).append(candidate)
        if len(values) == 1:
            first, *rest = candidates
            places = {tuple((s.segment_id, s.start) for s in c.spans) for c in candidates}
            first.alternatives += [c.spans for c in rest if tuple((s.segment_id, s.start) for s in c.spans) in places
                                   and c.spans != first.spans]
            merged.append(first)
            continue
        chosen = _arbitrate(run, number, path, [group[0] for group in values.values()], texts)
        contest.append({"path": list(path), "candidates": [{"value": group[0].value, "spans": _spans(group[0].spans),
                                                            "window": group[0].window} for group in values.values()],
                        "outcome": "arbitrated" if chosen is not None else "unresolved"})
        if chosen is not None:
            merged.append(chosen)
        else:
            run.issue("competitors_unresolved", f"{len(values)} verified values disagree", number, path)
    return merged, contest


def _arbitrate(run: _Run, number: int, path: tuple, candidates: list[_Outcome], texts: dict) -> _Outcome | None:
    labels = [f"C{index}" for index in range(1, len(candidates) + 1)]
    lines = []
    for label, candidate in zip(labels, candidates, strict=True):
        span = candidate.spans[0]
        text = texts[span.segment_id]
        snippet = text[max(0, span.start - 80):min(len(text), span.end + 80)].replace("\n", " ")
        lines.append(f"{label}: {candidate.value} — …{snippet}…")
    user = f"### Field\n{'.'.join(str(step) for step in path[2:])}\n\n### Candidates\n" + "\n".join(lines)
    answer = run.call("arbitration", number, ARBITRATION, user, {
        "type": "object", "properties": {"choice": {"type": "string", "enum": [*labels, NONE]}},
        "required": ["choice"], "additionalProperties": False})
    choice = answer.get("choice") if isinstance(answer, dict) else None
    return candidates[labels.index(choice)] if choice in labels else None


def _place(record: dict, path: tuple, value: Any) -> None:
    target: Any = record
    for step, following in zip(path, (*path[1:], None), strict=True):
        if following is None:
            if isinstance(target, list):
                target.extend([None] * (step + 1 - len(target)))
            target[step] = value
            return
        container = [] if isinstance(following, int) else {}
        if isinstance(target, list):
            target.extend([None] * (step + 1 - len(target)))
            target[step] = target[step] if target[step] is not None else container
        else:
            target.setdefault(step, container)
        target = target[step]


def _record(schema: Schema, record: dict) -> dict:
    return conform(record, schema.record_nodes)


# --- document fields, artifact shapes ------------------------------------------------------------------------------

def _document(run: _Run) -> dict:
    """The document-level fields from one call over as much of the source as the budget allows; unverified, as in
    version 1, and reported when the source had to be shortened."""
    nodes = run.schema.document_nodes
    if not nodes:
        return {}
    system = "\n".join([GUARDRAIL.split(". Answer")[0] + ".", f"A record is: {run.schema.record_description}",
                        *notes(nodes)])
    passages = list(run.evidence.passages)
    count = len(passages)
    low, high = 0, count
    while low < high:  # the most leading passages whose request fits
        middle = (low + high + 1) // 2
        text = text_of(passages[:middle])
        if run.count("document", system, f"### Source document\n{text}\n\nReturn the JSON object now.",
                     json_schema(nodes)) <= run.options.input_tokens:
            low = middle
        else:
            high = middle - 1
    if low < count:
        run.issue("text_truncated", f"document fields were read from the first {low} of {count} passages")
    answer = run.call("document", None, system, f"### Source document\n{text_of(passages[:low])}\n\nReturn the JSON "
                      "object now.", json_schema(nodes))
    return conform(answer, nodes)


def _spans(spans: list[Span]) -> list[dict]:
    return [{"segment": span.segment_id, "start": span.start, "end": span.end} for span in spans]


def _raw(spans: list[Span], texts: dict) -> str:
    return "".join(texts[span.segment_id].text[span.start:span.end] for span in spans)


def _expansions(glossary: Sequence[GlossaryEntry]) -> dict[str, GlossaryEntry]:
    """The document's glossary by key without its closing period, since `G.` may be quoted as `G`; a key that the
    period's removal makes expand two ways is dropped, as the segmentation drops a key printed twice."""
    found: dict[str, list[GlossaryEntry]] = {}
    for entry in glossary:
        found.setdefault(entry.key.rstrip("."), []).append(entry)
    return {key: entries[0] for key, entries in found.items() if key and len({e.expansion for e in entries}) == 1}


def _normalized(outcome: _Outcome, texts: dict, expansions: dict[str, GlossaryEntry]) -> dict | None:
    """An accepted string whose source text is a glossary key, expanded as the glossary prints it; the record keeps
    the raw value, and both glossary spans are the expansion's evidence."""
    if not isinstance(outcome.value, str):
        return None
    entry = expansions.get(_raw(outcome.spans, texts).rstrip("."))
    if entry is None:
        return None
    return {"value": entry.expansion, "rule": "glossary", "key_span": _spans([entry.key_span])[0],
            "expansion_span": _spans([entry.expansion_span])[0]}


def _link(outcome: _Outcome, texts: dict, expansions: dict[str, GlossaryEntry]) -> dict:
    first = texts[outcome.spans[0].segment_id]
    cells = [cell for cell in first.table.cells if cell.bbox_pt is not None
             and all(span.segment_id == first.id and cell.start <= span.start < span.end <= cell.end
                     for span in outcome.spans)] if first.table and not outcome.alternatives else []
    cell = cells[0] if len(cells) == 1 else None
    return {"path": list(outcome.path), "segment": first.id, "page": first.page,
            "bbox_pt": list(cell.bbox_pt if cell else first.bbox_pt), "cell": cell.cell_id if cell else None,
            "verbatim": True, "hits": 1 + len(outcome.alternatives), "linked_by": outcome.linked_by,
            "spans": _spans(outcome.spans), "alternatives": [_spans(spans) for spans in outcome.alternatives],
            "provenance": outcome.provenance, "key_spans": _spans(outcome.key_spans), "heading": outcome.heading,
            "precision": "cell" if cell else first.precision, "raw": _raw(outcome.spans, texts),
            "normalized": _normalized(outcome, texts, expansions)}


def _item(outcome: _Outcome, texts: dict) -> dict:
    item = {"path": list(outcome.path), "value": outcome.value, "quote": outcome.quote, "key": outcome.key,
            "provenance": outcome.provenance, "spans": _spans(outcome.spans),
            "alternatives": [_spans(spans) for spans in outcome.alternatives], "window": outcome.window}
    if outcome.reason is not None:
        item["reason"] = outcome.reason
    if outcome.spans:
        item["raw"] = _raw(outcome.spans, texts)
    return item


def _total(values) -> int | None:
    known = [value for value in values if value is not None]
    return sum(known) if known else None
