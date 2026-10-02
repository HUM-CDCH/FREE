"""The document and record value stages as plain functions over passages and a chat (plan B rule 6).

This module owns the value prompts: the guardrail and schema instruction (`_instruction`, which Article's inventory
shares), the labelled-passage rendering Article inventory and Catalog discovery share (`_labelled`), and the
document and record requests (`extract_document`, `record_request`, which also asks for Article's document-scope root
under `DOCUMENT`). Each record is extracted with one structured-output call under that guardrail; its answer is
conformed to the schema here. The merge orders a record's fields as the schema does and adds the document-level and
filename fields. Article requests use served-token admission. The call itself — routing to a role's model, admission,
invocation, reading the reply and its `Call` accounting — is `calls.complete`. How records are found belongs to each
strategy: version 1 Catalog discovery lives in `catalog.py`, Article's one document root and its value contexts in
`article.py`. Grounding the extracted values lives in `grounding.py`, which uses the value helpers defined here.
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
from kei_exp.kie.extract.tokens import BudgetUnavailable, TokenCounter
from kei_exp.kie.passages import Evidence, Passage, text_of

if TYPE_CHECKING:
    from kei_exp.kie.extract.calls import Call

GUARDRAIL = ("You extract structured data from a source document. Use only the requested output fields. Copy "
             "values from the source as written unless the field defines normalized labels; do not invent "
             "unsupported information. A value the source does not give is null. Return only the JSON object.")
ARTICLE = ("Extract only the specified record, combining its evidence across the complete source. Keep its final "
           "preparation or fraction distinct from the starting material, bulk preparation, other fractions and "
           "comparison controls. Collect ALL observations requested by the schema, including the same analyte "
           "reported on different bases or in different units. Never substitute group averages, another record's "
           "measurements, or protocol settings for this record's measurements. A proposed or attempted isolation "
           "is not proof of a recovered material or type. Use the field's defined identity labels.")
# Article's document scope: the document itself is the one object, so no identity is named and nothing is excluded.
DOCUMENT = ("The document is the one object to extract: the source below is all or part of it, and it holds no other "
            "records to tell apart. Every requested field, including every array, gathers everything the source "
            "states: an array lists every item given, in source order, each item with its own fields.")


@dataclass(frozen=True)
class Link:
    """One extracted value's evidence: the result path and the passage it was read from."""
    path: tuple[str | int, ...]
    segment: str
    page: int
    bbox_pt: tuple[float, float, float, float]
    verbatim: bool                      # the value occurs as a bounded token in the passage
    hits: int                           # passages of the record containing the value; above one is ambiguous
    linked_by: str                      # model (lexical only in results from before PROMPT_VERSION 13)
    cell: str | None = None             # local cell identity within segment, only with measured geometry
    precision: str = "segment"


@dataclass(frozen=True)
class Issue:
    code: str
    detail: str
    record: int | None = None
    path: tuple[str | int, ...] | None = None


def _labelled(passages: Sequence[Passage], labels: Sequence[str]) -> str:
    return "\n\n".join(f"[{label}] {passage.text.strip()}" for label, passage in zip(labels, passages, strict=True))


def _instruction(schema: Schema, nodes: Sequence) -> str:
    lines = [GUARDRAIL, f"A record is: {schema.record_description}", *notes(nodes)]
    return "\n".join(lines)


def pages_of(passages: Sequence[Passage]) -> str:
    """`page 3` or `pages 3–5`: the pages a contiguous run of passages lies on."""
    first, last = passages[0].page, passages[-1].page
    return f"page {first}" if first == last else f"pages {first}–{last}"


def _unshown(passages: Sequence[Passage], budget: int) -> str:
    """The passages `text_of` places at or beyond `budget`, in segment terms: the first one cut, from the code point
    of its own text where the cut falls, through the last one."""
    start = 0
    for index, passage in enumerate(passages):
        stripped = passage.text.strip()
        if start + len(stripped) > budget:
            break
        start += len(stripped) + 2  # the blank line text_of puts between passages
    cut = passages[index:]
    first = cut[0].id
    if start < budget:
        lead = len(passage.text) - len(passage.text.lstrip())
        first += f" from code point {lead + budget - start}"
    through = f" through {cut[-1].id}" if len(cut) > 1 else ""
    return f"{first}{through} ({pages_of(cut)})"


def _clipped(passages: Sequence[Passage], budget: int, issues: list[Issue], record: int | None) -> str:
    """The passages' text cut at `budget` characters, with a `text_truncated` issue naming the source not shown."""
    text = text_of(passages)
    if len(text) > budget:
        issues.append(Issue("text_truncated", f"{len(text)} characters of text, {budget} shown to the model; "
                            f"not shown: {_unshown(passages, budget)}", record))
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
    answer, attempts = complete(chat, stage="document", record=None, system=_instruction(schema, nodes), user=user,
                                schema=json_schema(nodes), counter=counter, max_tokens=2048 if counter else None)
    if not attempts[-1].ok:
        issues.append(Issue("call_failed", attempts[-1].error or "document extraction failed"))
    return conform(answer, nodes), attempts, issues


def extract_record(passages: Sequence[Passage], schema: Schema, chat: Chat, *, budget: int,
                   record: int | None = None, identity: dict | None = None, record_name: str | None = None,
                   counter: TokenCounter | None = None, neutral: bool = False,
                   structured: bool = False, document: bool = False) -> tuple[dict, list[Call], list[Issue]]:
    """One record's fields from one structured-output call over its passages; with `document`, the document's own
    root (Article) from one of its value contexts."""
    nodes = [node for node in schema.record_nodes if identity is None or node.name not in identity]
    if not nodes:
        return dict(identity or {}), [], []
    issues: list[Issue] = []
    if structured and counter is None:
        raise BudgetUnavailable("Structured source rendering requires a token counter")
    source = (structured_source(passages) if structured else
              text_of(passages) if counter else _clipped(passages, budget, issues, record))
    system, user, reply_schema = record_request(source, schema, identity, record_name, neutral=neutral,
                                                document=document)
    answer, attempts = complete(chat, stage="record", record=record, system=system, user=user,
                                schema=reply_schema, counter=counter, max_tokens=4096 if counter else None)
    if not attempts[-1].ok:
        issues.append(Issue("call_failed", attempts[-1].error or "record extraction failed", record))
    return {**(identity or {}), **conform(answer, nodes)}, attempts, issues


def record_request(source: str, schema: Schema, identity: dict | None, record_name: str | None, *, neutral=False,
                   document=False):
    """The same prompt builder serves token admission and execution. `document` is Article's document scope: every
    record field is asked of the whole document under `DOCUMENT`, with no identity, record name or exclusion."""
    nodes = [node for node in schema.record_nodes if identity is None or node.name not in identity]
    if document:
        user = f"### Source document\n{source}\n\nReturn the JSON object now."
        return DOCUMENT + "\n" + _instruction(schema, nodes), user, json_schema(nodes)
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
