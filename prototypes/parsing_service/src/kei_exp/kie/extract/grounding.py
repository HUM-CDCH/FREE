"""Grounding: linking a record's extracted values to the passages that support them, as interchangeable techniques.

Every technique has one call shape: a record's passages, its fields, the schema and a chat, keyword-only
`record`, `budget`, `counter`, `record_context`, `before_call`, `proofs` and `skip_paths`, returning the record's links, the
model calls made and the issues found. `assembly.ground_records` obtains one technique through `technique` and calls it once
per verification group of each record; it does not know which technique it holds. A new grounding arm is a new
function of this shape and one more entry in `technique`.

`semantic` is the production reference: bounded grounding calls that may answer only with an evidence label each
claim was shown, or NONE, reading each claim with its field and sibling fields. A label outside the shown set links
nothing. Every claim is verified, even a value that occurs as a bounded token in exactly one passage: the same
string can belong to another field or another record, so a unique text hit is a candidate location (the matching
cells offered and the `hits` count recorded), never field evidence on its own. Every grounding batch also shows the
record's fields, so a claim batched apart from the fields that identify its record still says whose it is. The
version 1 Catalog grounds under a character budget; Article adds its record identity and a served counter, and shows a
projection instead of the whole record (`projected`): a document root can hold hundreds of list items, and a request
embedding them all could not fit however few claims it carried.
`quoted` also asks for an exact source quote and an attribution to this record, in batches of four claims, and
records each accepted quote in `proofs`. `spans` selects canonical ranges and reconstructs their quotes. `off` makes
no call and links nothing, leaving every value ungrounded. Links from before this rule may carry
`linked_by: "lexical"`; none are made now.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from kei_exp.kie.extract.calls import Call, complete
from kei_exp.kie.extract.llm import Chat
from kei_exp.kie.extract.method import GroundingChoice
from kei_exp.kie.extract.schema import Schema, describe
from kei_exp.kie.extract.stages import Issue, Link, _text, contains, leaves
from kei_exp.kie.extract.spans import SourceSpan, source_spans
from kei_exp.kie.extract.tokens import TokenCounter
from kei_exp.kie.passages import Passage
from kei_exp.pagefile import TableCell

_GROUNDING_RULES = ("Each claim names its field: the same string in an unrelated detail is not evidence. "
                    "For tables, use the column headers and the claim's sibling fields to select the correct row. "
                    "Prefer the individual cell supporting the value; row context alone is not evidence for "
                    "that cell's value. Never invent a label.")
GROUNDING = ("Ground every claim listed under \"### Claims\" in the passages listed under \"### Evidence\". Return "
             "JSON with one key per claim label whose value is exactly one evidence label that directly supports "
             "the claim in the meaning of its field, or NONE when no passage supports it. " + _GROUNDING_RULES)
QUOTED_GROUNDING = (
    "Ground every claim listed under \"### Claims\" in the passages listed under \"### Evidence\". "
    "Return a single JSON object keyed by claim label; each value is an object with keys label, quote, and attribution. "
    "The label identifies offered evidence; quote is an exact, case-sensitive substring of that candidate's "
    "text, preserving whitespace; attribution is true only if it supports this value for THIS record, "
    "including its preparation, conditions, row and column. A matching number for another subject is not "
    "support. When unsupported, use label NONE, an empty quote and attribution false. "
    "Do not paraphrase or normalize source text. Escape control characters in JSON strings, for example "
    "a source tab as \\t. " + _GROUNDING_RULES)
NONE = "NONE"
SPAN_GROUNDING = (
    'Ground every claim under "### Claims" in the offered canonical source spans. Return one object per claim '
    'with "label" (exactly an offered evidence label or NONE) and "attribution" (a boolean). Select a span and set '
    'attribution true ONLY when its text, read with the supplied context, supports this field for the specified '
    'record and sibling attributes. A matching number or valid ID alone is insufficient. Use NONE and false '
    'when support is absent or uncertain. Do not return quote text; the server reconstructs it. All claim '
    'keys are required. Read adjacent ranges together; their boundaries are not semantic boundaries. '
    + _GROUNDING_RULES)


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


def _grounding_evidence(labelled: Sequence[tuple[str, _Candidate | SourceSpan]], *,
                        context_rows: frozenset[tuple[str, int]] | set[tuple[str, int]] = frozenset(),
                        passages: dict[str, Passage] | None = None) -> str:
    """Selectable evidence, then shared table context. Each context cell is printed at most once.

    `context_rows` (passage id, row) are printed in the context too, with their tables (from `passages`): a list item's
    own row when no offered cell lies in it, so an offered section header can be placed against its item."""
    lines = [f"{label}: {candidate.shown()}" for label, candidate in labelled]
    tables: dict[str, Passage] = {}
    rows: dict[str, set[int]] = {}
    for _, candidate in labelled:
        if candidate.cell is not None:
            tables[candidate.passage.id] = candidate.passage
            rows.setdefault(candidate.passage.id, set()).add(candidate.cell.row)
    for identity, row in sorted(context_rows):
        tables.setdefault(identity, (passages or {})[identity])
        rows.setdefault(identity, set()).add(row)
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


def _hits(candidates: Sequence[_Candidate | SourceSpan], value: Any) -> list[_Candidate | SourceSpan]:
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


def _enclosing(fields: dict, path: tuple[str | int, ...]) -> list[str]:
    """The scalar fields of each object enclosing `path` below the record (a list item, a nested object), outermost
    first, named by its path: what tells this claim's item from another holding an equal value. Lists are not shown."""
    lines, node = [], fields
    for depth, step in enumerate(path[:-1]):
        node = node[step]
        if isinstance(node, dict):
            scalars = {key: value for key, value in node.items() if isinstance(value, (str, int, float, bool))}
            lines.append(f"Within {_item_path(path[:depth + 1])}: {json.dumps(scalars, ensure_ascii=False)}")
    return lines


def _enclosing_item(fields: dict, path: tuple[str | int, ...]) -> dict | None:
    """The list item directly holding the leaf at `path` (below the record), or None outside a list."""
    if len(path) < 3 or not isinstance(path[-2], int):
        return None
    node: Any = fields
    for step in path[:-1]:
        node = node[step]
    return node if isinstance(node, dict) else None


def _item_path(path: tuple[str | int, ...]) -> str:
    return "".join(f"[{step}]" if isinstance(step, int) else f".{step}" for step in path).lstrip(".")


def verify(passages: Sequence[Passage], fields: dict, schema: Schema, chat: Chat, *, record: int,
           budget: int = 24_000, counter: TokenCounter | None = None, record_context: str | None = None,
           before_call: Callable[[], None] | None = None, quoted: bool = False,
           proofs: list[dict] | None = None, span_ids: bool = False,
           skip_paths: frozenset[tuple[str | int, ...]] = frozenset(), projected: bool = False) -> tuple[
        list[Link], list[Call], list[Issue]]:
    """Ground claims in complete evidence, splitting claim batches to fit the request budget.

    `projected` (Article) shows the record's own scalar fields once and, beside each claim, the scalar fields of every
    list item enclosing it, instead of the whole record: a request's size then depends on its claims and source, never
    on how many other items the record holds. The reply is budgeted too (every label at its longest within the output
    reserve), and a failed call names each claim it held.

    Every batch retains all passages for coarse/non-verbatim support, and all matching cells for its claims.
    An oversized single claim stays ungrounded with a diagnostic; evidence is never truncated to fit.
    Every claim is verified by the model, a uniquely found value included. Every batch carries the record's fields,
    counted in its size, so splitting never separates a claim from its record. Generic Catalog uses a character cap;
    Article adds its record identity and a served counter, verifying within the context minus an output reserve.
    `before_call`, when given, runs before each grounding batch; its error ends verification (cancellation).
    """
    prefix: tuple[str | int, ...] = ("records", record)
    if quoted and span_ids:
        raise ValueError("choose quoted or span-ID verification, not both")
    instruction = SPAN_GROUNDING if span_ids else QUOTED_GROUNDING if quoted else GROUNDING
    if not passages:
        return [], [], [Issue("no_evidence", "the record has no passages to verify against", record)]
    links: list[Link] = []
    candidates = source_spans(passages) if span_ids else _candidates(passages)
    pending: list[tuple[tuple[str | int, ...], Any, int]] = []
    for path, value in leaves(fields):
        if (*prefix, *path) in skip_paths:
            continue
        pending.append(((*prefix, *path), value, len(_hits(candidates, value))))
    if not pending:
        return links, [], []
    # Labels are local to this catalogue; saved proofs retain canonical source identities.
    labelled = {f"E{n}": candidate for n, candidate in enumerate(candidates, 1)}
    claims = {f"C{n}": claim for n, claim in enumerate(pending, 1)}
    eligible = {claim: [label for label, candidate in labelled.items()
                        if candidate.cell is None or contains(candidate.text, value)]
                for claim, (_, value, _) in claims.items()}
    # A list item's claim located to one row that no offered cell lies in: that row, printed as table context.
    context_rows: dict[str, set[tuple[str, int]]] = {}
    if projected:
        # A value printed in many table rows ("1", a brand name) offers every such cell; a list item's claim is offered
        # only the cells in the rows printing its item's most distinctive other value (the one in fewest rows: its own
        # row, by an article number), when there are any. A candidate location only: the model still decides support,
        # and an item without such a row keeps every cell.
        cells_of: dict[tuple[str, int], list[str]] = {}
        for candidate in candidates:
            if candidate.cell is not None:
                for row in range(candidate.cell.row, candidate.cell.row + candidate.cell.rowspan):
                    cells_of.setdefault((candidate.passage.id, row), []).append(candidate.text)
        row_text = {row: "\t".join(texts) for row, texts in cells_of.items()}
        rows_of = {label: {(c.passage.id, row) for row in range(c.cell.row, c.cell.row + c.cell.rowspan)}
                   for label, c in labelled.items() if c.cell is not None}
        for claim, (path, _, _) in claims.items():
            item = _enclosing_item(fields, path[2:])
            if item is None:
                continue
            others = [value for key, value in item.items() if key != path[-1]
                      and isinstance(value, (str, int, float)) and not isinstance(value, bool)]
            printing = [rows for rows in ({row for row, text in row_text.items() if contains(text, other)}
                                          for other in others) if rows]
            if not printing:
                continue
            best = min(printing, key=len)
            own = [label for label in eligible[claim] if label in rows_of and rows_of[label] & best]
            if own:
                eligible[claim] = [label for label in eligible[claim] if label not in rows_of] + own
            elif len(best) == 1:  # no offered cell shows the item's own row (a section header): print that row
                context_rows[claim] = best
    claim_ids = list(claims)
    # Quotes have substantially larger replies than labels; keep their output bounded too.
    batch_size = 4 if quoted else 32 if span_ids else len(claim_ids)
    batches = [claim_ids[n:n + batch_size] for n in range(0, len(claim_ids), batch_size)]
    # Every batch shows the whole record, so a claim split away from the fields that identify its record is not
    # verified blind; the budget below counts these lines like the rest of the request.
    identity = f"### Record identity\n{record_context}\n" if record_context else ""
    record_fields = f"Record fields: {json.dumps(fields, ensure_ascii=False)}\n\n"
    if projected:
        own = {key: value for key, value in fields.items() if isinstance(value, (str, int, float, bool))}
        record_fields = f"Record fields (lists are shown per claim): {json.dumps(own, ensure_ascii=False)}\n\n"
    calls: list[Call] = []
    issues: list[Issue] = []
    while batches:
        batch = batches.pop(0)
        lines = []
        previous_parent = None
        for claim in batch:
            path, value, _ = claims[claim]
            if path[:-1] != previous_parent:
                lines += _enclosing(fields, path[2:]) if projected else [_siblings(fields, path[2:])]
                previous_parent = path[:-1]
            lines.append(f"{claim} ({describe(schema.record_nodes, path[2:])}): {_text(value)}")
        shown = {label for claim in batch for label in eligible[claim]}
        user = identity + record_fields + "### Claims\n" + "\n".join(lines) + "\n\n### Evidence\n" + _grounding_evidence(
            [(label, candidate) for label, candidate in labelled.items() if label in shown],
            context_rows={row for claim in batch for row in context_rows.get(claim, ())},
            passages={candidate.passage.id: candidate.passage for candidate in candidates})
        reply_schema = {"type": "object", "properties": {
            claim: {"type": "string", "enum": [*eligible[claim], NONE]} for claim in batch},
            "required": batch, "additionalProperties": False}
        if quoted:
            reply_schema["properties"] = {claim: {"type": "object", "properties": {
                "label": {"type": "string", "enum": [*eligible[claim], NONE]},
                "quote": {"type": "string", "maxLength": 500},
                "attribution": {"type": "boolean"}}, "required": ["label", "quote", "attribution"],
                "additionalProperties": False} for claim in batch}
        elif span_ids:
            reply_schema["properties"] = {claim: {"type": "object", "properties": {
                "label": {"type": "string", "enum": [*eligible[claim], NONE]},
                "attribution": {"type": "boolean"}}, "required": ["label", "attribution"],
                "additionalProperties": False} for claim in batch}
        size = len(instruction) + len(user) + len(json.dumps(reply_schema, ensure_ascii=False))
        if before_call is not None:
            before_call()
        count = counter.request_tokens(instruction, user, reply_schema) if counter else None
        exceeded = count + 2048 > counter.context_tokens if counter else size > budget
        if projected and not exceeded:  # the reply, every label at its longest, within the output reserve
            exceeded = len(json.dumps({claim: max([*eligible[claim], NONE], key=len) for claim in batch})) > 2048
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
        answer, attempts = complete(chat, stage="grounding", record=record, system=instruction, user=user,
                                   schema=reply_schema, counter=counter, max_tokens=2048 if counter else None)
        calls += attempts
        if not attempts[-1].ok:
            issues += ([Issue("call_failed", attempts[-1].error or "grounding failed", record, claims[claim][0])
                        for claim in batch] if projected else
                       [Issue("call_failed", attempts[-1].error or "grounding failed", record)])
            continue
        given = answer if isinstance(answer, dict) else {}
        for claim in batch:
            path, value, hits = claims[claim]
            label = given.get(claim)
            if span_ids:
                candidate_reply = label if isinstance(label, dict) else {}
                label = candidate_reply.get("label")
                if label in eligible[claim] and candidate_reply.get("attribution") is not True:
                    issues.append(Issue("unsupported_attribution", f"{claim}: source support was not attested", record, path))
                    continue
            if quoted:
                candidate_reply = label if isinstance(label, dict) else {}
                label = candidate_reply.get("label")
                if label in eligible[claim]:
                    quote = candidate_reply.get("quote")
                    if (candidate_reply.get("attribution") is not True or not isinstance(quote, str) or not quote.strip()
                            or len(quote) > 500
                            or quote not in labelled[label].text):
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
                elif span_ids and proofs is not None:
                    proofs.append({"path": list(path), "segment": candidate.passage.id,
                                   "cell": candidate.cell.cell_id if candidate.cell else None,
                                   "span": candidate.id, "start": candidate.start, "end": candidate.end,
                                   "quote": candidate.text, "attribution": "model_attested"})
    return links, calls, issues


def _link(path: tuple[str | int, ...], candidate: _Candidate | SourceSpan, verbatim: bool, hits: int, linked_by: str) -> Link:
    passage, cell = candidate.passage, candidate.cell
    precise = cell is not None and cell.bbox_pt is not None
    return Link(path, passage.id, passage.page, cell.bbox_pt if precise else passage.bbox_pt,
                verbatim, hits, linked_by, cell.cell_id if precise else None, "cell" if precise else passage.precision)


Grounding = Callable[..., tuple[list[Link], list[Call], list[Issue]]]


def semantic(passages: Sequence[Passage], fields: dict, schema: Schema, chat: Chat, *, record: int,
             budget: int = 24_000, counter: TokenCounter | None = None, record_context: str | None = None,
             before_call: Callable[[], None] | None = None, proofs: list[dict] | None = None,
             skip_paths: frozenset[tuple[str | int, ...]] = frozenset(), projected: bool = False) -> tuple[
        list[Link], list[Call], list[Issue]]:
    """The production reference: one evidence label per claim, or NONE."""
    return verify(passages, fields, schema, chat, record=record, budget=budget, counter=counter,
                  record_context=record_context, before_call=before_call, proofs=proofs, skip_paths=skip_paths,
                  projected=projected)


def quoted(passages: Sequence[Passage], fields: dict, schema: Schema, chat: Chat, *, record: int,
           budget: int = 24_000, counter: TokenCounter | None = None, record_context: str | None = None,
           before_call: Callable[[], None] | None = None, proofs: list[dict] | None = None,
           skip_paths: frozenset[tuple[str | int, ...]] = frozenset(), projected: bool = False) -> tuple[
        list[Link], list[Call], list[Issue]]:
    """A label, an exact source quote and an attribution per claim; accepted quotes are appended to `proofs`."""
    return verify(passages, fields, schema, chat, record=record, budget=budget, counter=counter,
                  record_context=record_context, before_call=before_call, quoted=True, proofs=proofs, skip_paths=skip_paths,
                  projected=projected)


def spans(passages: Sequence[Passage], fields: dict, schema: Schema, chat: Chat, *, record: int,
          budget: int = 24_000, counter: TokenCounter | None = None, record_context: str | None = None,
          before_call: Callable[[], None] | None = None, proofs: list[dict] | None = None,
          skip_paths: frozenset[tuple[str | int, ...]] = frozenset(), projected: bool = False) -> tuple[
        list[Link], list[Call], list[Issue]]:
    """Canonical spans with reconstructed quotes and model-attested attribution."""
    return verify(passages, fields, schema, chat, record=record, budget=budget, counter=counter,
                  record_context=record_context, before_call=before_call, proofs=proofs, skip_paths=skip_paths, span_ids=True,
                  projected=projected)


def off(passages: Sequence[Passage], fields: dict, schema: Schema, chat: Chat, *, record: int,
        budget: int = 24_000, counter: TokenCounter | None = None, record_context: str | None = None,
        before_call: Callable[[], None] | None = None, proofs: list[dict] | None = None,
        skip_paths: frozenset[tuple[str | int, ...]] = frozenset(), projected: bool = False) -> tuple[
        list[Link], list[Call], list[Issue]]:
    """No grounding: no call, no link, no issue; every value stays ungrounded."""
    return [], [], []


def technique(choice: GroundingChoice | None) -> Grounding:
    """The grounding function for an `ArticleOptions.grounding` choice; None, the production reference, is semantic."""
    return {None: semantic, "semantic": semantic, "quoted": quoted, "spans": spans, "off": off}[choice]
