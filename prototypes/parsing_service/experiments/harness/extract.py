"""Input, chunks, retrieval, schema groups and the model calls that turn a chunk into candidate records.

Everything here is a plain function over the service's own types: `Evidence` passages, `contexts.partition` chunks,
FREE `Schema` nodes and `calls.complete` (through `model.ask`). A candidate record is a dict of fields, each holding the
model's raw value beside the normalised one, its cited quotes or ids and its token statistics; resolving those citations
is `evidence.py`, joining candidates into records is `merge.py`.
"""
from __future__ import annotations

import json
import math
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from typing import Any

from jsonschema import Draft202012Validator

from experiments.harness.config import Config
from experiments.harness.data import Case, typed
from experiments.harness.model import BudgetExceeded, Metered, ask
from experiments.harness.signals import value_stats
from kei_exp.kie.extract.contexts import Context, partition
from kei_exp.kie.extract.rendering import structured_source
from kei_exp.kie.extract.schema import Node, json_schema, notes
from kei_exp.kie.extract.selection import words
from kei_exp.kie.extract.stages import GUARDRAIL
from kei_exp.kie.passages import Passage, text_of

RECORDS = "records"


@dataclass(frozen=True)
class Chunk:
    id: str
    context: Context
    retrieval: str = "all"          # all | top_k | expanded | skipped
    score: float | None = None      # lexical relevance, when retrieval scored it


@dataclass(frozen=True)
class Task:
    chunk: str
    group: int
    sample: int = 0
    view: str = "field"
    attempt: int = 0
    depth: int = 0
    source_part: tuple[int, ...] = ()  # passage subdivisions only; field subdivisions do not create source boundaries
    part: tuple[int, ...] = ()      # which halves of the chunk and of the group a subdivision kept: () is all of both

    @property
    def id(self) -> str:
        return f"{self.chunk}/g{self.group}/s{self.sample}/{self.view}" + ("/" + ".".join(map(str, self.part)) if self.part else "")


@dataclass
class Result:
    task: Task
    ok: bool
    error: str | None = None
    length: bool = False            # the reply was cut off: the failure a smaller request can cure
    records: tuple = ()
    begins: bool | None = None
    ends: bool | None = None
    calls: tuple = ()
    passages: tuple[str, ...] = ()  # the primary passages this task read
    fields: tuple[str, ...] = ()    # the fields it asked for
    recovered: str | None = None    # the error of the failed attempt whose halves this result is
    replies: int = 0                # replies received, retries included (a transport failure is not a reply)
    valid: int = 0                  # of them, the ones that parsed and matched the schema
    exhausted: bool = False         # a call or token budget stopped it: nothing more is sent for it


# --- input ---------------------------------------------------------------------------------------------------------

def render(passages: tuple[Passage, ...] | list[Passage], mode: str) -> str:
    return structured_source(passages) if mode == "layout" else text_of(passages)


def chunks_of(passages: list[Passage], cfg: Config) -> list[Chunk]:
    """Whole passages, in reading order, with disjoint primary text. An indivisible oversized passage is a chunk of its
    own, so the caller can refuse it visibly instead of cutting it. Overlap is the tail of the previous chunk's primary text
    on top of a primary that already fits: `partition` would trade it against the budget and drop it silently, which turns
    an overlap experiment into a no-op."""
    def fits(part) -> bool:
        return len(render(part, cfg.input.mode)) <= cfg.chunking.max_chars
    chunking = cfg.chunking
    match chunking.mode:
        case "whole":
            contexts = [Context(tuple(passages))]
        case "fixed":
            contexts = partition(passages, fits)
        case "structure":
            contexts = partition(passages, fits, structural=True)
        case "page":
            contexts = []
            for page in dict.fromkeys(p.page for p in passages):
                contexts += partition([p for p in passages if p.page == page], fits)
    if chunking.overlap and chunking.mode != "whole":     # the tail of the previous chunk, which may lie on the previous page
        contexts = [context if index == 0 else replace(context, overlap=tuple(contexts[index - 1].primary[-chunking.overlap:]))
                    for index, context in enumerate(contexts)]
    return [Chunk(f"c{index}", context) for index, context in enumerate(contexts)]


def _bm25(query: list[str], documents: list[list[str]]) -> list[float]:
    counts = [Counter(document) for document in documents]
    average = sum(len(document) for document in documents) / max(1, len(documents)) or 1
    frequency = Counter(term for count in counts for term in count)
    return [sum(math.log(1 + (len(documents) - frequency[term] + 0.5) / (frequency[term] + 0.5))
                * count[term] * 2.2 / (count[term] + 1.2 * (0.25 + 0.75 * len(document) / average))
                for term in set(query) if count[term]) for count, document in zip(counts, documents, strict=True)]


def retrieve(chunks: list[Chunk], nodes: list[Node], description: str, cfg: Config) -> list[Chunk]:
    """Lexical retrieve-then-extract: the `top_k` chunks by BM25 against the fields' names and descriptions, then
    `expand` neighbours each side. Chunks not chosen stay listed as skipped, with their scores: retrieval is never a
    claim that every relevant record was found."""
    if cfg.retrieval.mode == "exhaustive":
        return chunks
    query = words(description + "\n" + "\n".join(notes(nodes)) + "\n" + " ".join(node.name for node in nodes))
    scores = _bm25(query, [words(text_of(chunk.context.primary)) for chunk in chunks])
    top = sorted(range(len(chunks)), key=lambda i: (-scores[i], i))[:cfg.retrieval.top_k]
    reach = {j for i in top for j in range(i - cfg.retrieval.expand, i + cfg.retrieval.expand + 1) if 0 <= j < len(chunks)}
    return [replace(chunk, score=round(scores[i], 8), retrieval="top_k" if i in top else "expanded" if i in reach else "skipped")
            for i, chunk in enumerate(chunks)]


def groups_of(case: Case, cfg: Config) -> list[list[Node]]:
    """Field groups. Each group repeats the declared key fields so that records of different groups can be joined."""
    nodes = case.schema.record_nodes
    by_name = {node.name: node for node in nodes}
    decompose = cfg.decompose
    if decompose.mode == "groups":
        listed = [name for group in decompose.groups for name in group]
        if set(listed) != set(by_name) or len(listed) != len(set(listed)):
            raise ValueError(f"decompose.groups must list every field of the schema once: {sorted(by_name)}")
        groups = [[by_name[name] for name in group] for group in decompose.groups]
    elif decompose.mode == "max_fields":
        groups = [nodes[i:i + decompose.max_fields] for i in range(0, len(nodes), decompose.max_fields)]
    else:
        groups = [nodes]
    if len(groups) > 1:
        if not case.record_key:
            raise ValueError(f"{case.id}: schema groups join records on a declared record_key, which this case lacks")
        keys = [by_name[name] for name in case.record_key]
        groups = [[*(key for key in keys if key not in group), *group] for group in groups]
    return groups


# --- prompts and reply schemas ------------------------------------------------------------------------------------

def _wrapped(cfg: Config) -> bool:
    return cfg.evidence.mode in ("quote", "ids") or cfg.signals.verbalized


def _leaf(node: Node, cfg: Config, ids: list[str] | None) -> dict:
    value = json_schema([node])["properties"][node.name]
    if not _wrapped(cfg):
        return value
    props: dict[str, Any] = {"value": value}
    if cfg.evidence.mode == "quote":
        props["quotes"] = {"type": "array", "items": {"type": "string"}}
    if cfg.evidence.mode == "ids":
        props["ids"] = {"type": "array", "items": {"type": "string", **({"enum": ids} if ids is not None else {})}}
    if cfg.signals.verbalized:
        props["confidence"] = {"type": "number"}
    return {"type": ["object", "null"], "properties": props, "required": list(props), "additionalProperties": False}


def reply_schema(nodes: list[Node], cfg: Config, ids: list[str] | None) -> dict:
    """The reply's schema. With `ids` the cited ids are an enum of what the chunk showed (what a provider-native
    constraint enforces); without, any string (what local validation checks, so that a stray id is a citation that does not
    exist, visible to the checks, and not a lost region)."""
    record = {"type": "object", "properties": {node.name: _leaf(node, cfg, ids) for node in nodes},
              "required": [node.name for node in nodes], "additionalProperties": False}
    props: dict[str, Any] = {RECORDS: {"type": "array", "items": record}}
    if cfg.merge.continuation == "flags":
        props |= {"begins_inside_record": {"type": ["boolean", "null"]}, "ends_inside_record": {"type": ["boolean", "null"]}}
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


DOCUMENT_SCHEMA = {"type": "object", "properties": {RECORDS: {"type": "array", "items": {
    "type": "object", "properties": {"facts": {"type": "array", "items": {"type": "object", "properties": {
        "label": {"type": "string"}, "value": {"type": "string"}}, "required": ["label", "value"],
        "additionalProperties": False}}}, "required": ["facts"], "additionalProperties": False}}},
    "required": [RECORDS], "additionalProperties": False}


def system_prompt(case: Case, nodes: list[Node], cfg: Config, schema: dict | None) -> str:
    lines = [GUARDRAIL, f"A record is: {case.schema.record_description}",
             "Extract EVERY record that has text in the SOURCE, including one that runs on past its end or began in "
             "EARLIER TEXT (give such a record whole). Return {\"records\": [...]}, one object per record, in source order."]
    if cfg.evidence.mode == "quote":
        lines.append("For every field give \"value\" and \"quotes\": the exact source text, copied character for "
                     "character, that states it (several quotes when it is stated in several places).")
    elif cfg.evidence.mode == "ids":
        lines.append("For every field give \"value\" and \"ids\": the id of each <block> that states it.")
    if cfg.signals.verbalized:
        lines.append("Also give \"confidence\": a number from 0 to 1, how sure you are the value is right.")
    if cfg.merge.continuation == "flags":
        lines.append("Answer \"begins_inside_record\": true when the first record began before the SOURCE, and "
                     "\"ends_inside_record\": true when the last record continues after it (null when unsure).")
    lines += notes(nodes)
    if schema is not None and cfg.output.constraint == "prompt":
        lines.append("Answer with JSON matching this schema exactly: " + json.dumps(schema, ensure_ascii=False))
    return "\n".join(lines)


def user_prompt(chunk: Chunk, cfg: Config, passages: tuple[Passage, ...] | None = None) -> str:
    context = chunk.context
    primary = context.primary if passages is None else passages
    parts = ([f"### EARLIER TEXT (context)\n{render(context.overlap, cfg.input.mode)}"] if context.overlap else []) + \
        ([f"### HEADING (context)\n{render((context.heading,), cfg.input.mode)}"] if context.heading else []) + \
        [f"### SOURCE\n{render(primary, cfg.input.mode)}"]
    return "\n\n".join(parts) + "\n\nReturn the JSON object now."


# --- one call ----------------------------------------------------------------------------------------------------

def validate(schema: dict, parsed: Any) -> list[str]:
    return [error.message[:200] for error in Draft202012Validator(schema).iter_errors(parsed)][:3]


def _candidates(parsed: dict, nodes: list[Node], cfg: Config, task: Task, reply) -> list[dict]:
    wrapped = _wrapped(cfg)
    found = []
    for k, record in enumerate(parsed[RECORDS]):
        fields = {}
        for node in nodes:
            cell = record.get(node.name)
            given = cell if isinstance(cell, dict) else None
            raw = (given or {}).get("value") if wrapped else cell
            value, changed = typed(raw, node)
            path = (RECORDS, k, node.name, *(("value",) if wrapped else ()))
            fields[node.name] = {"raw": raw if raw not in ("", []) else None, "value": value, "normalized": changed,
                                 "typed": raw in (None, "", []) or value is not None,
                                 "quotes": list((given or {}).get("quotes") or []), "ids": list((given or {}).get("ids") or []),
                                 "verbalized": (given or {}).get("confidence"), "stats": value_stats(reply, path)}
        found.append({"chunk": task.chunk, "group": task.group, "sample": task.sample, "view": task.view, "index": k,
                      "source_part": task.source_part, "part": task.part,
                      "begins": parsed.get("begins_inside_record"), "ends": parsed.get("ends_inside_record"), "fields": fields})
    return found


def run_field_task(task: Task, chunk: Chunk, passages: tuple[Passage, ...], nodes: list[Node], case: Case, cfg: Config,
                   meter: Metered) -> Result:
    """One call over `passages` of a chunk for the fields `nodes`; a failed call is a failed result, never records."""
    schema = reply_schema(nodes, cfg, [p.id for p in (*chunk.context.overlap, *passages)])
    lenient = reply_schema(nodes, cfg, None)
    seed = None if cfg.sampling.seed is None else cfg.sampling.seed + task.sample
    ids, asked = tuple(p.id for p in passages), tuple(node.name for node in nodes)
    try:
        parsed, calls, reply = ask(meter, stage="record", system=system_prompt(case, nodes, cfg, schema),
                                   user=user_prompt(chunk, cfg, passages), schema=schema if cfg.output.constraint == "schema" else None,
                                   max_tokens=cfg.output.max_tokens, attempt=task.attempt, sample=task.sample,
                                   temperature=cfg.sampling.temperature, seed=seed, top_logprobs=cfg.signals.top_logprobs)
    except BudgetExceeded as error:    # the region stays failed on the ledger; what other tasks read is kept
        return Result(task, False, f"budget exhausted: {error}", passages=ids, fields=asked, exhausted=True)
    last = calls[-1] if calls else None
    replied = int(reply is not None)
    if parsed is None or last is None or not last.ok:
        return Result(task, False, (last.error if last else "no call") or "call failed", last is not None and last.finish == "length",
                      calls=tuple(calls), passages=ids, fields=asked, replies=replied)
    problems = validate(lenient, parsed)
    if problems:
        return Result(task, False, "reply does not match the schema: " + "; ".join(problems), calls=tuple(calls), passages=ids,
                      fields=asked, replies=1)
    candidates = _candidates(parsed, nodes, cfg, task, reply)
    for candidate in candidates:
        candidate["shown"] = [p.id for p in (*chunk.context.overlap, *passages)]
        candidate["primary"] = [p.id for p in passages]
    return Result(task, True, records=tuple(candidates), begins=parsed.get("begins_inside_record"),
                  ends=parsed.get("ends_inside_record"), calls=tuple(calls), passages=ids, fields=asked, replies=1, valid=1)


def run_document_task(task: Task, chunk: Chunk, case: Case, cfg: Config, meter: Metered) -> Result:
    """The document-guided view: the model lists what the source states, in its own labels; no field is named."""
    system = "\n".join([GUARDRAIL, f"The source describes records of this kind: {case.schema.record_description}",
                        "List every record in the SOURCE and, for each, every fact it states as a label and a value, using "
                        "the source's own labels. Return {\"records\": [{\"facts\": [{\"label\": ..., \"value\": ...}]}]}."])
    try:
        parsed, calls, _ = ask(meter, stage="discovery", system=system, user=user_prompt(chunk, cfg),
                               schema=DOCUMENT_SCHEMA if cfg.output.constraint == "schema" else None, max_tokens=cfg.output.max_tokens,
                               attempt=task.attempt, sample=task.sample, temperature=0.0)
    except BudgetExceeded as error:
        return Result(task, False, f"budget exhausted: {error}", exhausted=True)
    last = calls[-1] if calls else None
    if parsed is None or last is None or not last.ok or validate(DOCUMENT_SCHEMA, parsed):
        return Result(task, False, (last.error if last else "no call") or "document view failed", calls=tuple(calls))
    return Result(task, True, records=tuple({"chunk": chunk.id, "view": "document", "index": k,
                                             "facts": [(f["label"], f["value"]) for f in record["facts"]]}
                                            for k, record in enumerate(parsed[RECORDS])), calls=tuple(calls))


def split_task(task: Task, passages: tuple[Passage, ...], nodes: list[Node], length: bool, case: Case
               ) -> list[tuple[Task, tuple[Passage, ...], list[Node]]]:
    """Two smaller tasks in place of a failed one, made from what that task read (so each level is smaller than its
    parent): the fields halved after a cut-off reply (a shorter reply; each half repeats the record key so the halves'
    records can be joined, which is why it needs a declared key), else the passages halved (which can cut a record: only
    continuation flags or overlap can rejoin it). Together the halves read what the task read; nothing is dropped."""
    keys = [n for n in nodes if n.name in case.record_key]
    rest = [n for n in nodes if n.name not in case.record_key]
    if length and case.record_key and len(rest) > 1:
        half = len(rest) // 2
        return [(replace(task, part=(*task.part, i), depth=task.depth + 1, attempt=0), passages, [*keys, *part])
                for i, part in enumerate((rest[:half], rest[half:]))]
    if len(passages) > 1:
        half = len(passages) // 2
        return [(replace(task, part=(*task.part, i), source_part=(*task.source_part, i), depth=task.depth + 1, attempt=0), part, nodes)
                for i, part in enumerate((passages[:half], passages[half:]))]
    return []


def with_recovery(task: Task, chunk: Chunk, passages: tuple[Passage, ...], nodes: list[Node], case: Case, cfg: Config,
                  meter: Metered) -> list[Result]:
    """The task and, when it fails, its bounded recovery: retries of the same request, then (if enabled) the smaller halves.
    Every attempt's calls are kept on the result they produced; the returned list holds a result per region read."""
    result = run_field_task(task, chunk, passages, nodes, case, cfg, meter)
    attempts = [result]
    for attempt in range(1, cfg.recovery.retries + 1):
        if result.ok or result.exhausted:
            break
        result = run_field_task(replace(task, attempt=attempt), chunk, passages, nodes, case, cfg, meter)
        attempts.append(result)
    tally = {"replies": sum(r.replies for r in attempts), "valid": sum(r.valid for r in attempts)}
    if result.ok:
        return [replace(result, calls=tuple(c for r in attempts for c in r.calls), **tally)]
    failed = replace(result, calls=tuple(c for r in attempts for c in r.calls), **tally)
    if not cfg.recovery.subdivide or task.depth >= cfg.recovery.depth or failed.exhausted:
        return [failed]
    halves = split_task(task, passages, nodes, result.length, case)
    if not halves:
        return [failed]
    out: list[Result] = []
    for part_task, part_passages, part_nodes in halves:
        out += with_recovery(part_task, chunk, part_passages, part_nodes, case, cfg, meter)
    # the failed attempt's calls and replies stay on record, on the first half that replaced it
    return [replace(out[0], calls=failed.calls + out[0].calls, recovered=failed.error, replies=out[0].replies + failed.replies,
                    valid=out[0].valid + failed.valid), *out[1:]]


def run_tasks(jobs: list, cfg: Config) -> list:
    """`jobs` are zero-argument callables; results keep the jobs' order whatever the concurrency."""
    if cfg.budget.workers == 1:
        return [job() for job in jobs]
    with ThreadPoolExecutor(max_workers=cfg.budget.workers) as pool:
        return [future.result() for future in [pool.submit(job) for job in jobs]]
