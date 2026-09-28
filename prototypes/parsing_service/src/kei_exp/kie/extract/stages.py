"""The extraction stages as plain functions over passages and a chat completion (plan B rule 6).

Each record is extracted with one structured-output call under a guardrail. The merge orders a record's fields as
the schema does and adds the document-level and filename fields. Article requests use served-token admission. How
records are found belongs to each strategy: version 1 Catalog discovery lives in `catalog.py`, the Article inventory
of noncontiguous records and their supporting passages in `article.py`. Grounding the extracted values lives in
`grounding.py`, which uses the value helpers and model admission defined here.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Any

from kei_exp.kie.extract.llm import Chat, ModelOutputError, parse_json
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.rendering import structured_source
from kei_exp.kie.extract.schema import Schema, conform, json_schema, notes
from kei_exp.kie.extract.tokens import BudgetUnavailable, TokenCounter
from kei_exp.kie.passages import Evidence, Passage, text_of

GUARDRAIL = ("You extract structured data from a source document. Use only the requested output fields. Copy "
             "values from the source as written unless the field defines normalized labels; do not invent "
             "unsupported information. A value the source does not give is null. Return only the JSON object.")
ARTICLE = ("Extract only the specified record, combining its evidence across the complete source. Keep its final "
           "preparation or fraction distinct from the starting material, bulk preparation, other fractions and "
           "comparison controls. Collect ALL observations requested by the schema, including the same analyte "
           "reported on different bases or in different units. Never substitute group averages, another record's "
           "measurements, or protocol settings for this record's measurements. A proposed or attempted isolation "
           "is not proof of a recovered material or type. Use the field's defined identity labels.")


@dataclass(frozen=True)
class Call:
    """One model call as the artifact reports it."""
    stage: str                          # discovery | inventory | document | record | grounding
    record: int | None
    input_tokens: int | None
    output_tokens: int | None
    seconds: float
    finish: str | None
    ok: bool
    error: str | None = None
    counted_input_tokens: int | None = None
    context_tokens: int | None = None
    max_output_tokens: int | None = None


@dataclass(frozen=True)
class Link:
    """One extracted value's evidence: the result path and the passage it was read from."""
    path: tuple[str | int, ...]
    segment: str
    page: int
    bbox_pt: tuple[float, float, float, float]
    verbatim: bool                      # the value occurs as a bounded token in the passage
    hits: int                           # passages of the record containing the value; above one is ambiguous
    linked_by: str                      # lexical | model
    cell: str | None = None             # local cell identity within segment, only with measured geometry
    precision: str = "segment"


@dataclass(frozen=True)
class Issue:
    code: str
    detail: str
    record: int | None = None
    path: tuple[str | int, ...] | None = None


def _complete(chat: Chat | Router, *, stage: str, record: int | None, system: str, user: str, schema: dict,
              max_tokens: int | None = None, counter: TokenCounter | None = None) -> tuple[Any, list[Call]]:
    """One call, read as JSON; a truncated or unreadable reply is a failed call and a null answer. The calls are the
    attempts in order, the last one the call whose reply this is: a refused earlier attempt is a failed call too.
    A router sends the call to the model serving the stage's role."""
    if isinstance(chat, Router):
        chat = chat.for_stage(stage)
    counted = None
    if counter is not None:
        assert max_tokens is not None
        counted = counter.request_tokens(system, user, schema)
        context = counter.context_tokens
        if type(context) is not int or context <= 0:
            raise BudgetUnavailable("Article requires the serving endpoint's context size")
        if counted + max_tokens > context:
            return None, [Call(stage, record, None, None, 0.0, None, False,
                f"{counted} input + {max_tokens} output tokens exceed the served context {context}; "
                "complete source was not sent", counted, context, max_tokens)]
    try:
        reply = chat.complete(system=system, user=user, schema=schema, max_tokens=max_tokens)
    except ModelOutputError as error:  # a fake or a client that already judged the reply
        return None, [Call(stage, record, None, None, 0.0, None, False, str(error),
                           counted, counter.context_tokens if counter else None, max_tokens)]
    refused = [Call(stage, record, None, None, 0.0, None, False, attempt) for attempt in reply.attempts]
    parsed = None
    error = None
    if reply.finish == "length":
        error = "the reply was cut off (finish_reason length)"
    else:
        try:
            parsed = parse_json(reply.text)
        except ModelOutputError as exc:
            error = str(exc)
    if error is None and counted is not None and reply.input_tokens != counted:
        error = f"counted {counted} input tokens but the server reported {reply.input_tokens}"
    return parsed, [*refused, Call(stage, record, reply.input_tokens, reply.output_tokens, reply.seconds,
        reply.finish, error is None, error, counted, counter.context_tokens if counter else None, max_tokens)]


def _labelled(passages: Sequence[Passage], labels: Sequence[str]) -> str:
    return "\n\n".join(f"[{label}] {passage.text.strip()}" for label, passage in zip(labels, passages, strict=True))


def _instruction(schema: Schema, nodes: Sequence) -> str:
    lines = [GUARDRAIL, f"A record is: {schema.record_description}", *notes(nodes)]
    return "\n".join(lines)


def _clipped(passages: Sequence[Passage], budget: int, issues: list[Issue], record: int | None) -> str:
    text = text_of(passages)
    if len(text) > budget:
        issues.append(Issue("text_truncated", f"{len(text)} characters of text, {budget} shown to the model", record))
        text = text[:budget]
    return text


def extract_document(evidence: Evidence, schema: Schema, chat: Chat, *, budget: int,
                     counter: TokenCounter | None = None, structured: bool = False) -> tuple[
        dict, list[Call], list[Issue]]:
    """The fields that belong to the document as a whole, from one call over its text."""
    nodes = schema.document_nodes
    if not nodes:
        return {}, [], []
    issues: list[Issue] = []
    if structured and counter is None:
        raise BudgetUnavailable("Structured source rendering requires a token counter")
    source = (structured_source(evidence.passages) if structured else
              text_of(evidence.passages) if counter else _clipped(evidence.passages, budget, issues, None))
    user = f"### Source document\n{source}\n\nReturn the JSON object now."
    answer, attempts = _complete(chat, stage="document", record=None, system=_instruction(schema, nodes), user=user,
                                 schema=json_schema(nodes), counter=counter, max_tokens=2048 if counter else None)
    if not attempts[-1].ok:
        issues.append(Issue("call_failed", attempts[-1].error or "document extraction failed"))
    return conform(answer, nodes), attempts, issues


def extract_record(passages: Sequence[Passage], schema: Schema, chat: Chat, *, budget: int,
                   record: int | None = None, identity: dict | None = None, record_name: str | None = None,
                   counter: TokenCounter | None = None, neutral: bool = False,
                   structured: bool = False) -> tuple[dict, list[Call], list[Issue]]:
    """One record's fields from one structured-output call over its passages."""
    nodes = [node for node in schema.record_nodes if identity is None or node.name not in identity]
    if not nodes:
        return dict(identity or {}), [], []
    issues: list[Issue] = []
    if structured and counter is None:
        raise BudgetUnavailable("Structured source rendering requires a token counter")
    source = (structured_source(passages) if structured else
              text_of(passages) if counter else _clipped(passages, budget, issues, record))
    system, user, reply_schema = record_request(source, schema, identity, record_name, neutral=neutral)
    answer, attempts = _complete(chat, stage="record", record=record, system=system, user=user,
                                 schema=reply_schema, counter=counter, max_tokens=4096 if counter else None)
    if not attempts[-1].ok:
        issues.append(Issue("call_failed", attempts[-1].error or "record extraction failed", record))
    return {**(identity or {}), **conform(answer, nodes)}, attempts, issues


def record_request(source: str, schema: Schema, identity: dict | None, record_name: str | None, *, neutral=False):
    """The same prompt builder serves token admission and execution."""
    nodes = [node for node in schema.record_nodes if identity is None or node.name not in identity]
    user = f"### Source document\n{source}\n\n" if record_name else f"### Record\n{source}\n\n"
    user += "Return the JSON object now."
    system = ((f"Extract ONLY the record {record_name}: " + "; ".join(f"{key}: {value}" for key, value in (identity or {}).items()) +
               ". Read only its corresponding table rows/columns. Exclude every other record.\n" +
               ("Return null for attributes that this source unit does not support for this record. "
                "Do not transfer values between distinct subjects. Follow the schema's definitions." if neutral else ARTICLE) + "\n")
              if record_name else "") + _instruction(schema, nodes)
    return system, user, json_schema(nodes)


def leaves(value: Any, path: tuple[str | int, ...] = ()) -> Iterator[tuple[tuple[str | int, ...], Any]]:
    """Every populated leaf: a non-blank string or a number. Booleans and nulls are not claims to ground."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield from leaves(item, (*path, key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from leaves(item, (*path, index))
    elif isinstance(value, bool) or value is None:
        return
    elif isinstance(value, str):
        if value.strip():
            yield path, value
    else:
        yield path, value


def normal(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def _text(value: Any) -> str:
    """A value as the source would print it: an integral float (1827.0) as its integer."""
    return str(int(value)) if isinstance(value, float) and value.is_integer() else str(value)


def contains(haystack: str, value: Any) -> bool:
    """Whether `value` occurs in `haystack` as a bounded token: not inside a longer word or number."""
    needle, hay = normal(_text(value)), normal(haystack)
    if not needle:
        return False
    for match in re.finditer(re.escape(needle), hay):
        before = hay[match.start() - 1] if match.start() > 0 else " "
        after = hay[match.end()] if match.end() < len(hay) else " "
        if not before.isalnum() and not after.isalnum():
            return True
    return False


def merge(fields: dict, document: dict, filename: str, schema: Schema) -> dict:
    """One record in schema order: its own fields, then the document's, then the filename's."""
    merged: dict[str, Any] = {}
    for node in schema.nodes:
        if node.value_source == "document":
            merged[node.name] = document.get(node.name)
        elif node.value_source == "source-filename":
            merged[node.name] = filename
        else:
            merged[node.name] = fields.get(node.name)
    return merged
