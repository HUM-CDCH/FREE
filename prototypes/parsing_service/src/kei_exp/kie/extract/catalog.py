"""The version 1 Catalog: generic record discovery, then one call per record slice, each grounded in its slice.

Discovery asks which labelled passages open a record and cuts the passages into record slices at those starts; only
the final chunk may close the records with an `end`, since an earlier chunk cannot know what follows it. Each
slice's values are read from the slice alone under the character budget (`record_chars`) and grounded in it by the
reference technique. Text the budget cuts is named in a `text_truncated` issue, and a discovery window whose call
fails names the pages it left unsearched; neither is silent. A record call that loops on whitespace is asked once
more under a grammar bounding the whitespace between JSON tokens (`MAX_WHITESPACE`); both calls stay in the
artifact. This module owns the discovery prompt and reply schema and reads the starts and end off the reply; record
values use `stages.extract_record`, and every model call goes through `calls.complete`. The artifact is assembled in
`assembly.py`, as Article's is. A request that names a recipe runs the grounded Catalog (`grounded.py`) instead.
"""
from __future__ import annotations

import re
import time
from collections.abc import Callable, Sequence
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import requests

from kei_exp.failures import should_retry
from kei_exp.kie.extract.assembly import artifact, document_values, ground_records, unchecked
from kei_exp.kie.extract.calls import Call, complete, looped
from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.llm import Chat, bounded
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.retained import saved_record, plan_records
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.stages import Issue, _labelled, extract_record, pages_of
from kei_exp.kie.passages import Evidence, Passage

# Without reasoning, "the first block AFTER the last record" read to qwen3:8b as the last record itself.
DISCOVERY = ("Identify record boundaries in the labelled source text. A record is: {description}\nReturn JSON "
             "with \"starts\", the labels of the blocks that OPEN each record, in source order without duplicates; "
             "the last record opens at a start too. Return \"end\" as null when the last record runs to the end of "
             "the text; otherwise \"end\" is the label of the first block after the last record that belongs to no "
             "record, such as a bibliography or index. A block that opens a record is never the end. Do not select "
             "continuation text, descriptions, items listed within a record or section headings unless they themselves "
             "open a record.")
DISCOVERY_EXAMPLES = """
Examples (structure only; use only labels from the actual input):
Input: [B1] Contents
[B2] 1. First entry.
[B3] More text of the first entry.
[B4] 2. Second entry.
Output: {"starts":["B2","B4"],"end":null}
Input: [B1] Part A
[B2] An entry.
[B3] Part B
[B4] Another entry.
[B5] More text of that entry.
[B6] Index
[B7] Entry, 2.
Output: {"starts":["B2","B4"],"end":"B6"}
"""
# 3 October 2026 live calls: a looping record read 3/3 under xgrammar's grammar admitting 16 whitespace characters
# between JSON tokens, where the same schema through response_format looped 2/2. A server-wide limit changed other
# records' values, so the bound applies only to a call that already looped.
MAX_WHITESPACE = 16


def extract(run_dir: Path | None, evidence: Evidence, request, chat: Router, *, counter=None, chunks: int = 1,
            before_entry: Callable[[], None] | None = None) -> dict:
    """The version 1 Catalog artifact for `request` (the validated `run.ExtractRequest`) over `evidence`.

    `before_entry` is called before the document-level call, each discovery call, each record's extraction and
    verification, and each grounding batch; what it raises ends the extraction. `run_dir`, `counter` and `chunks` are
    not used: the records are read under a character budget and run unsplit."""
    check = before_entry or unchecked
    started = datetime.now(UTC).isoformat()
    clock = time.monotonic()
    schema = request.schema_
    options = request.options
    document, _, calls, issues = document_values(evidence, [Context(evidence.passages)], schema, chat,
                                                 budget=options.record_chars, check=check)
    # discovery checks before each of its calls
    groups, discovery_calls, discovery_issues = discover(evidence, schema, chat, budget=options.discovery_chars,
                                                        before_call=check)
    calls += discovery_calls
    issues += discovery_issues
    plan_records(chat,"generic-records",[[{"segment":p.id,"start":0,"end":len(p.text)} for p in group] for group in groups])
    slices = []
    for number, group in enumerate(groups):
        check()
        fields, record_calls, record_issues = _record(group, schema, chat, budget=options.record_chars,
                                                      number=number, check=check)
        calls += record_calls
        issues += record_issues
        saved_record(chat, fields, [{"segment": p.id, "start": 0, "end": len(p.text)} for p in group],
                     record=number, primary=[{"segment": p.id, "start": 0, "end": len(p.text)} for p in group]
                     if all(call.ok or call.recovered for call in record_calls) else [])
        slices.append((group, fields))
    support = ground_records(slices, schema, chat, budget=options.record_chars, check=check)
    return artifact(evidence, request, chat, started=started, clock=clock, fields=[fields for _, fields in slices],
                    document=document, links=support.links, calls=calls + support.calls, issues=issues + support.issues)


def _record(group: Sequence[Passage], schema: Schema, chat: Router, *, budget: int, number: int,
            check: Callable[[], None]) -> tuple[dict, list[Call], list[Issue]]:
    """One record's values. A call that looped on whitespace is asked once more under the bounded grammar: a reply
    read there replaces the first answer and marks the looped call `recovered`; a refused or failed recovery leaves
    the first answer and adds its call and failure. A transient refusal is raised for the step's retry."""
    fields, calls, issues = extract_record(group, schema, chat, budget=budget, record=number)
    recovery = bounded(chat.fields, MAX_WHITESPACE) if calls and looped(calls[-1]) else None
    if recovery is None:
        return fields, calls, issues
    check()
    started = time.monotonic()
    try:
        again, again_calls, again_issues = extract_record(group, schema, replace(chat, fields=recovery),
                                                          budget=budget, record=number)
    except requests.HTTPError as error:
        if should_retry(error):
            raise
        refused = Call("record", number, None, None, time.monotonic() - started, None, False,
                       f"whitespace-loop recovery refused: HTTP {error.response.status_code}: "
                       f"{error.response.text[:300]}")
        return fields, [*calls, refused], issues
    if again_calls[-1].ok:
        return again, [*calls[:-1], replace(calls[-1], recovered=True), *again_calls], again_issues
    return fields, calls + again_calls, issues + [issue for issue in again_issues if issue.code == "call_failed"]


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
        answer, attempts = complete(chat, stage="discovery", record=None, system=system,
                                    user=_labelled(passages[first:last], shown), schema=reply_schema)
        calls += attempts
        call = attempts[-1]
        if not call.ok:
            window = shown[0] if len(shown) == 1 else f"{shown[0]}–{shown[-1]}"
            issues.append(Issue("call_failed", f"{call.error or 'discovery failed'}; no record start was searched for "
                                f"on {pages_of(passages[first:last])} ({window})"))
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
