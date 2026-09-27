"""The extraction stages as plain functions over passages and a chat completion (plan B rule 6).

Catalog discovery asks which labelled passages open a record and cuts the passages into record slices at
those starts; only the final chunk may close the records with an `end`, since an earlier chunk cannot know what
follows it. Each record is extracted with one structured-output call under a guardrail. Verification is
deterministic first: a value that occurs as a bounded token in exactly one of the record's passages is linked
without a model; the rest go to bounded grounding calls that may answer only with an evidence label each claim
was shown, or NONE. A label outside the shown set links nothing. The merge orders a record's fields as the
schema does and adds the document-level and filename fields. Article instead inventories noncontiguous records
and their supporting passages; its verification is semantic even for unique lexical occurrences, because the
whole document contains other records' measurements. Article requests use served-token admission.
"""
from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from typing import Any

from kei_exp.kie.extract.evidence import Evidence, Passage, text_of
from kei_exp.kie.extract.llm import Chat, ModelOutputError, parse_json
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.rendering import structured_source
from kei_exp.kie.extract.schema import Schema, conform, describe, json_schema, notes
from kei_exp.kie.extract.tokens import BudgetUnavailable, TokenCounter
from kei_exp.pagefile import TableCell

GUARDRAIL = ("You extract structured data from a source document. Use only the requested output fields. Copy "
             "values from the source as written unless the field defines normalized labels; do not invent "
             "unsupported information. A value the source does not give is null. Return only the JSON object.")
# Without reasoning, "the first block AFTER the last record" read to qwen3:8b as the last record itself.
DISCOVERY = ("Identify record boundaries in the labelled source text. A record is: {description}\nReturn JSON "
             "with \"starts\", the labels of the blocks that OPEN each record, in source order without duplicates; "
             "the last record opens at a start too. Return \"end\" as null when the last record runs to the end of "
             "the text; otherwise \"end\" is the label of the first block after the last record that belongs to no "
             "record, such as a bibliography or index. A block that opens a record is never the end. Do not select "
             "continuation text, descriptions, finds within a record or section headings unless they themselves "
             "open a record.")
DISCOVERY_EXAMPLES = """
Examples (independent documents; use only labels from the actual input):
Input: [B1] Regional inventory
[B2] 7. Oak: urn.
[B3] Another fragment from Oak.
[B4] 8. Brook: axe.
Output: {"starts":["B2","B4"],"end":null}
Input: [B1] Northern region
[B2] Reed: a bronze spear.
[B3] Southern region
[B4] Mere: a clay bowl.
[B5] A decorated rim was also recovered at Mere.
[B6] References
[B7] Smith 1998.
Output: {"starts":["B2","B4"],"end":"B6"}

Input: [B1] Inventory
[B2] 12. Marsh: a burial with these finds:
[B3] 1. A clay vessel.
[B4] 2. A bone pin.
[B5] 13. Heath: a stone axe.
[B6] A second axe was found at Heath.
Output: {"starts":["B2","B5"],"end":null}
"""
GROUNDING = ("Ground every claim listed under \"### Claims\" in the passages listed under \"### Evidence\". Return "
             "JSON with one key per claim label whose value is exactly one evidence label that directly supports "
             "the claim in the meaning of its field, or NONE when no passage supports it. Each claim names its "
             "field: the same string in an unrelated detail is not evidence. For tables, use the column headers "
             "and the claim's sibling fields to select the correct row. Prefer the individual cell supporting "
             "the value; row context alone is not evidence for that cell's value. Never invent a label.")
NONE = "NONE"
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


def _chunks(passages: Sequence[Passage], budget: int) -> list[tuple[int, int]]:
    """Half-open index ranges of whole pages whose labelled text fits `budget` characters; a page that alone
    exceeds it stands as its own chunk."""
    ranges: list[tuple[int, int]] = []
    start, size = 0, 0
    for index, passage in enumerate(passages):
        new_page = index > 0 and passage.page != passages[index - 1].page
        if new_page and size + _page_size(passages, index) > budget and index > start:
            ranges.append((start, index))
            start, size = index, 0
        size += len(passage.text) + 12
    if start < len(passages):
        ranges.append((start, len(passages)))
    return ranges


def _page_size(passages: Sequence[Passage], index: int) -> int:
    page = passages[index].page
    return sum(len(p.text) + 12 for p in passages[index:] if p.page == page)


def discover(evidence: Evidence, schema: Schema, chat: Chat, *, budget: int,
             before_call: Callable[[], None] | None = None) -> tuple[list[list[Passage]], list[Call], list[Issue]]:
    """Record slices of the passages, in order, cut at the starts the model names; labels run on across chunks.

    Only the final chunk may close the records with an `end`: an earlier chunk cannot know what follows it. An end
    named earlier, or one that lies at or before a record start, is ignored with an issue; a record is never
    dropped for it. `before_call`, when given, runs before each chunk's call; its error ends discovery (the worker's
    cooperative cancellation)."""
    passages = list(evidence.passages)
    labels = [f"B{n}" for n in range(1, len(passages) + 1)]
    system = DISCOVERY.format(description=schema.record_description) + DISCOVERY_EXAMPLES
    starts: list[int] = []
    end: int | None = None
    calls: list[Call] = []
    issues: list[Issue] = []
    chunks = _chunks(passages, budget)
    for number, (first, last) in enumerate(chunks):
        if before_call is not None:
            before_call()
        shown = labels[first:last]
        reply_schema = {"type": "object", "properties": {
            "starts": {"type": "array", "items": {"type": "string", "enum": shown}},
            "end": {"type": ["string", "null"], "enum": [*shown, None]}},
            "required": ["starts", "end"], "additionalProperties": False}
        answer, attempts = _complete(chat, stage="discovery", record=None, system=system,
                                     user=_labelled(passages[first:last], shown), schema=reply_schema)
        calls += attempts
        call = attempts[-1]
        if not call.ok:
            issues.append(Issue("call_failed", call.error or "discovery failed"))
            continue
        given = answer.get("starts", []) if isinstance(answer, dict) else []
        for label in given if isinstance(given, list) else []:
            index = _index(label, labels)
            if index is None or index < first or index >= last or (starts and index <= starts[-1]):
                issues.append(Issue("discovery_ignored_label", f"start {label!r} is unknown, repeated or out of order"))
                continue
            starts.append(index)
        named = answer.get("end") if isinstance(answer, dict) else None
        if not isinstance(named, str):
            continue
        index = _index(named, labels)
        if number + 1 < len(chunks):
            issues.append(Issue("discovery_ignored_label", f"end {named!r} named in chunk {number + 1} of "
                                f"{len(chunks)} is ignored: only the final chunk may close the records"))
        elif index is None or index < first or index >= last:
            issues.append(Issue("discovery_ignored_label", f"end {named!r} is unknown or was not shown"))
        else:
            end = index
    if not starts:
        issues.append(Issue("no_records_found", "the model named no record start"))
    if end is not None and starts and starts[-1] >= end:
        issues.append(Issue("discovery_inconsistent_end", f"end {labels[end]!r} lies at or before the last record "
                            f"start {labels[starts[-1]]!r} and is ignored: the records run to the end of the text"))
        end = None
    issues += _numbering_issues(passages, labels, starts, end)
    stop = end if end is not None else len(passages)
    slices = [passages[start:min(stop, starts[n + 1]) if n + 1 < len(starts) else stop]
              for n, start in enumerate(starts)]
    return [group for group in slices if group], calls, issues


_NUMBERED = re.compile(r"\s*\d{1,4}[.)]\s")


def _numbering_issues(passages: Sequence[Passage], labels: Sequence[str], starts: Sequence[int],
                      end: int | None) -> list[Issue]:
    """Where the record starts are numbered entries, a numbered block the end drops or an unnumbered start is
    most likely a boundary the model misread. Reported, never corrected; without numbered starts, silent."""
    numbered = [bool(_NUMBERED.match(passages[index].text)) for index in starts]
    issues: list[Issue] = []
    if end is not None and numbered and all(numbered):
        issues += [Issue("discovery_numbered_after_end", f"{labels[index]!r} is numbered like every record start, "
                         f"but the end {labels[end]!r} drops it")
                   for index in range(end, len(passages)) if _NUMBERED.match(passages[index].text)]
    if sum(numbered) >= 2:
        issues += [Issue("discovery_unnumbered_start", f"start {labels[index]!r} is not numbered like the other "
                         "record starts") for index, ok in zip(starts, numbered, strict=True) if not ok]
    return issues


def _index(label: Any, labels: Sequence[str]) -> int | None:
    return labels.index(label) if isinstance(label, str) and label in labels else None


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


@dataclass(frozen=True)
class _Candidate:
    passage: Passage
    cell: TableCell | None = None

    @property
    def text(self) -> str:
        return self.cell.text if self.cell else self.passage.text

    def shown(self) -> str:
        if self.cell is None:
            return self.text.strip()
        return f"Cell {self.passage.id}/{self.cell.cell_id}: {self.text!r}"


def _grounding_evidence(labelled: Sequence[tuple[str, _Candidate]]) -> str:
    """Selectable evidence, then shared table context. Each context cell is printed at most once."""
    lines = [f"{label}: {candidate.shown()}" for label, candidate in labelled]
    tables: dict[str, Passage] = {}
    rows: dict[str, set[int]] = {}
    for _, candidate in labelled:
        if candidate.cell is not None:
            tables[candidate.passage.id] = candidate.passage
            rows.setdefault(candidate.passage.id, set()).add(candidate.cell.row)
    for identity, passage in tables.items():
        assert passage.table is not None
        lines.append(f"Table {identity} row/header context (not selectable evidence labels):")
        for cell in passage.table.cells:
            if cell.role in {"column_header", "row_section"} or any(
                    cell.row <= row < cell.row + cell.rowspan for row in rows[identity]):
                lines.append(f"{cell.cell_id} row={cell.row} column={cell.column} "
                             f"rowspan={cell.rowspan} colspan={cell.colspan} {cell.role}: {cell.text!r}")
    return "\n".join(lines)


def _candidates(passages: Sequence[Passage]) -> list[_Candidate]:
    candidates = []
    for passage in passages:
        candidates.append(_Candidate(passage))
        if passage.table:
            candidates.extend(_Candidate(passage, cell) for cell in passage.table.cells if cell.text.strip())
    return candidates


def _hits(candidates: Sequence[_Candidate], value: Any) -> list[_Candidate]:
    found = [candidate for candidate in candidates if contains(candidate.text, value)]
    cell_parents = {candidate.passage.id for candidate in found if candidate.cell is not None}
    return [candidate for candidate in found if candidate.cell is not None or candidate.passage.id not in cell_parents]


def _siblings(fields: dict, path: tuple[str | int, ...]) -> str:
    parent: Any = fields
    for part in path[:-1]:
        parent = parent[part]
    if not isinstance(parent, dict):
        return ""
    siblings = {key: value for key, value in parent.items() if isinstance(value, (str, int, float, bool))}
    return f"Sibling fields: {json.dumps(siblings, ensure_ascii=False)}" if siblings else ""


def verify(passages: Sequence[Passage], fields: dict, schema: Schema, chat: Chat, *, record: int,
           budget: int = 24_000, counter: TokenCounter | None = None, record_context: str | None = None,
           before_call: Callable[[], None] | None = None, quoted: bool = False,
           proofs: list[dict] | None = None) -> tuple[
        list[Link], list[Call], list[Issue]]:
    """Ground claims in complete evidence, splitting claim batches to fit the request budget.

    Every batch retains all passages for coarse/non-verbatim support, and all matching cells for its claims.
    An oversized single claim stays ungrounded with a diagnostic; evidence is never truncated to fit.
    Generic Catalog uses a character cap and links unique lexical hits. Article supplies its record context
    and a served counter: every claim is semantically verified within the context minus an output reserve.
    """
    prefix: tuple[str | int, ...] = ("records", record)
    instruction = GROUNDING
    if quoted:
        instruction += (" For each claim return label, quote, and attribution. Quote an exact nonempty substring of "
                        "the chosen evidence that supports the claim. Set attribution true only if that evidence "
                        "supports this value for THIS record, including its preparation, conditions, row and column. "
                        "A matching number for another subject is not support. Use label NONE, empty quote and "
                        "attribution false when unsupported. Do not paraphrase the quote.")
    if not passages:
        return [], [], [Issue("no_evidence", "the record has no passages to verify against", record)]
    links: list[Link] = []
    candidates = _candidates(passages)
    pending: list[tuple[tuple[str | int, ...], Any, int]] = []
    for path, value in leaves(fields):
        hits = _hits(candidates, value)
        if len(hits) == 1 and record_context is None and not quoted:
            links.append(_link((*prefix, *path), hits[0], True, 1, "lexical"))
        else:
            pending.append(((*prefix, *path), value, len(hits)))
    if not pending:
        return links, [], []
    labelled = {f"E{n}": candidate for n, candidate in enumerate(candidates, 1)}
    claims = {f"C{n}": claim for n, claim in enumerate(pending, 1)}
    eligible = {claim: [label for label, candidate in labelled.items()
                        if candidate.cell is None or contains(candidate.text, value)]
                for claim, (_, value, _) in claims.items()}
    claim_ids = list(claims)
    # Quotes have substantially larger replies than labels; keep their output bounded too.
    batches = [claim_ids[n:n + 4] for n in range(0, len(claim_ids), 4)] if quoted else [claim_ids]
    calls: list[Call] = []
    issues: list[Issue] = []
    while batches:
        batch = batches.pop(0)
        lines = []
        previous_parent = None
        for claim in batch:
            path, value, _ = claims[claim]
            if path[:-1] != previous_parent:
                lines.append(_siblings(fields, path[2:]))
                previous_parent = path[:-1]
            lines.append(f"{claim} ({describe(schema.record_nodes, path[2:])}): {_text(value)}")
        shown = {label for claim in batch for label in eligible[claim]}
        context = (f"### Record identity\n{record_context}\n"
                   f"Record fields: {json.dumps(fields, ensure_ascii=False)}\n\n" if record_context else "")
        user = context + "### Claims\n" + "\n".join(lines) + "\n\n### Evidence\n" + _grounding_evidence(
            [(label, candidate) for label, candidate in labelled.items() if label in shown])
        reply_schema = {"type": "object", "properties": {
            claim: {"type": "string", "enum": [*eligible[claim], NONE]} for claim in batch},
            "required": batch, "additionalProperties": False}
        if quoted:
            reply_schema["properties"] = {claim: {"type": "object", "properties": {
                "label": {"type": "string", "enum": [*eligible[claim], NONE]},
                "quote": {"type": "string", "maxLength": 500},
                "attribution": {"type": "boolean"}}, "required": ["label", "quote", "attribution"],
                "additionalProperties": False} for claim in batch}
        size = len(instruction) + len(user) + len(json.dumps(reply_schema, ensure_ascii=False))
        if before_call is not None:
            before_call()
        count = counter.request_tokens(instruction, user, reply_schema) if counter else None
        exceeded = count + 2048 > counter.context_tokens if counter else size > budget
        if exceeded:
            if len(batch) > 1:
                middle = len(batch) // 2
                batches[0:0] = [batch[:middle], batch[middle:]]
            else:
                issues.append(Issue("grounding_exceeds_budget",
                                    (f"{count} input + 2048 output tokens exceed {counter.context_tokens}" if counter
                                     else f"{size} characters exceed {budget}") + "; complete evidence was not sent",
                                    record, claims[batch[0]][0]))
            continue
        answer, attempts = _complete(chat, stage="grounding", record=record, system=instruction, user=user,
                                    schema=reply_schema, counter=counter, max_tokens=2048 if counter else None)
        calls += attempts
        if not attempts[-1].ok:
            issues.append(Issue("call_failed", attempts[-1].error or "grounding failed", record))
            continue
        given = answer if isinstance(answer, dict) else {}
        for claim in batch:
            path, value, hits = claims[claim]
            label = given.get(claim)
            if quoted:
                candidate_reply = label if isinstance(label, dict) else {}
                label = candidate_reply.get("label")
                if label in eligible[claim]:
                    quote = candidate_reply.get("quote")
                    if (candidate_reply.get("attribution") is not True or not isinstance(quote, str) or not quote.strip()
                            or len(quote) > 500
                            or normal(quote) not in normal(labelled[label].text)):
                        issues.append(Issue("unsupported_quote", f"{claim}: missing attribution or source substring", record, path))
                        continue
            if label is None:
                issues.append(Issue("missing_claim", f"the model did not answer {claim}", record, path))
            elif label == NONE:
                continue
            elif label not in eligible[claim]:
                issues.append(Issue("unknown_label", f"{claim} was linked to {label!r}, which was not offered", record, path))
            else:
                candidate = labelled[label]
                links.append(_link(path, candidate, contains(candidate.text, value), hits, "model"))
                if quoted and proofs is not None:
                    proofs.append({"path": list(path), "segment": candidate.passage.id,
                                   "cell": candidate.cell.cell_id if candidate.cell else None,
                                   "quote": candidate_reply["quote"], "attribution": "model_attested"})
    return links, calls, issues


def _link(path: tuple[str | int, ...], candidate: _Candidate, verbatim: bool, hits: int, linked_by: str) -> Link:
    passage, cell = candidate.passage, candidate.cell
    precise = cell is not None and cell.bbox_pt is not None
    return Link(path, passage.id, passage.page, cell.bbox_pt if precise else passage.bbox_pt,
                verbatim, hits, linked_by, cell.cell_id if precise else None, "cell" if precise else passage.precision)


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
