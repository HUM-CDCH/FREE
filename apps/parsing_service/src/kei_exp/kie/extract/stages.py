"""The document and record value stages as plain functions over passages and a chat (plan B rule 6).

This module owns Article's value prompts: the guardrail and schema instruction (`_instruction`), and the document and
record requests (`extract_document`, and `record_request`, which asks for Article's document-scope root under
`DOCUMENT`). Each is one structured-output call under that guardrail with served-token admission; its answer is
conformed to the schema here. The merge orders a record's fields as the schema does and adds the document-level and
filename fields. The call itself — routing to a role's model, admission, invocation, reading the reply and its `Call`
accounting — is `calls.complete`. Article's value contexts live in `article.py`. Grounding the extracted values lives
in `grounding.py`, which uses the value helpers defined here.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from kei_exp.kie.extract.calls import complete
from kei_exp.kie.extract.llm import Chat
from kei_exp.kie.extract.rendering import structured_source
from kei_exp.kie.extract.schema import Schema, conform, json_schema, notes
from kei_exp.kie.extract.tokens import TokenCounter
from kei_exp.kie.passages import Evidence, Passage, text_of

if TYPE_CHECKING:
    from kei_exp.kie.extract.calls import Call

GUARDRAIL = ("You extract structured data from a source document. Use only the requested output fields. Copy "
             "values from the source as written unless the field defines normalized labels; do not invent "
             "unsupported information. A value the source does not give is null. Return only the JSON object.")
# Article's document scope: the document itself is the one object, so no identity is named and nothing is excluded.
DOCUMENT = ("The document is the one object to extract: the source below is all or part of it, and it holds no other "
            "records to tell apart. Every requested field, including every array, gathers everything the source "
            "states: an array lists every item given, in source order, each item with its own fields.")
# The least reply allowance Article's document root is given (`extract_record`).
REPLY_TOKENS = 4096


@dataclass(frozen=True)
class Link:
    """One extracted value's evidence: the result path and the passage selected to support it."""
    path: tuple[str | int, ...]
    segment: str
    page: int
    bbox_pt: tuple[float, float, float, float]
    verbatim: bool                      # the value occurs as a bounded token in the passage
    linked_by: str                      # model: the grounding call chose the passage
    cell: str | None = None             # local cell identity within segment, only with measured geometry
    precision: str = "segment"
    location: dict | None = None        # Article only: the value's one printing, {spans: [{segment, start, end}], raw}
    context: tuple[dict, ...] = ()      # ranges attributing the value to its record, or the other half of a split word


@dataclass(frozen=True)
class Issue:
    code: str
    detail: str
    record: int | None = None
    path: tuple[str | int, ...] | None = None


def _instruction(schema: Schema, nodes: Sequence) -> str:
    lines = [GUARDRAIL, f"A record is: {schema.record_description}", *notes(nodes)]
    return "\n".join(lines)


def extract_document(evidence: Evidence, schema: Schema, chat: Chat, *, counter: TokenCounter,
                     structured: bool = False) -> tuple[dict, list[Call], list[Issue]]:
    """The fields that belong to the document as a whole, from one counted call over its text."""
    nodes = schema.document_nodes
    if not nodes:
        return {}, [], []
    issues: list[Issue] = []
    source = structured_source(evidence.passages) if structured else text_of(evidence.passages)
    user = f"### Source document\n{source}\n\nReturn the JSON object now."
    answer, attempts = complete(chat, stage="document", record=None, system=_instruction(schema, nodes), user=user,
                                schema=json_schema(nodes), counter=counter, max_tokens=2048)
    if not attempts[-1].ok:
        issues.append(Issue("call_failed", attempts[-1].error or "document extraction failed"))
    return conform(answer, nodes), attempts, issues


def extract_record(passages: Sequence[Passage], schema: Schema, chat: Chat, *, counter: TokenCounter,
                   record: int | None = None, structured: bool = False,
                   bounded_document: bool = False, page: int | None = None) -> tuple[dict, list[Call], list[Issue]]:
    """The document's own root (Article) from one structured-output call over one of its value contexts. The root
    restates every item its context gives, so its reply may use the served context its counted input leaves, and a
    context too full for `REPLY_TOKENS` is refused before sending (`calls.complete`). `page` is the page the call is
    read for, which sets its priority (`calls.complete`)."""
    nodes = schema.record_nodes
    if not nodes:
        return {}, [], []
    issues: list[Issue] = []
    source = structured_source(passages) if structured else text_of(passages)
    system, user, reply_schema = record_request(source, schema)
    counted = counter.request_tokens(system, user, reply_schema)
    minimum_reply_tokens = max(REPLY_TOKENS, counted) if bounded_document else REPLY_TOKENS
    max_tokens = max(REPLY_TOKENS, (counter.context_tokens or 0) - counted)
    answer, attempts = complete(chat, stage="record", record=record, system=system, user=user,
                                schema=reply_schema, counter=counter, max_tokens=max_tokens,
                                minimum_reply_tokens=minimum_reply_tokens, page=page)
    if not attempts[-1].ok:
        issues.append(Issue("call_failed", attempts[-1].error or "record extraction failed", record))
    return conform(answer, nodes), attempts, issues


def record_request(source: str, schema: Schema):
    """Article's document-scope root request; the same prompt builder serves token admission and execution. Every
    record field is asked of the whole document under `DOCUMENT`, with no identity, record name or exclusion."""
    nodes = schema.record_nodes
    user = f"### Source document\n{source}\n\nReturn the JSON object now."
    return DOCUMENT + "\n" + _instruction(schema, nodes), user, json_schema(nodes)


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
    return occurrences(haystack, value) > 0


def occurrences(haystack: str, value: Any) -> int:
    """How many times `value` occurs in `haystack` as a bounded token, as `contains` finds it."""
    needle, hay = normal(_text(value)), normal(haystack)
    if not needle:
        return 0
    found = 0
    for match in re.finditer(re.escape(needle), hay):
        before = hay[match.start() - 1] if match.start() > 0 else " "
        after = hay[match.end()] if match.end() < len(hay) else " "
        found += not before.isalnum() and not after.isalnum()
    return found


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
