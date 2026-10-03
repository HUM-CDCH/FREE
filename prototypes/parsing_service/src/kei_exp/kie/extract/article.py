"""Article: the document-scope extraction, one document-level object that may contain arrays.

`extract` is the Article implementation: the document's one root read in each of its value contexts (the complete
source by default, bounded parts with `options.article.context`), assembled across them by
`contexts.assemble_document`, verified in every source context, and the artifact assembled in `assembly.py`, as the
version 1 Catalog's is (`document_root`). No identity is inventoried: the artifact's `inventory` holds the one document
identity, every passage its support. The inventory of noncontiguous records (`inventory_request`, `inventory`,
`reconcile_identities`, `extract_records`) stays for the research replays that read captured version 1 studies; the
service path does not call it. Every model call goes through `calls.complete`; the shared value prompts live in
`stages.py` and grounding in `grounding.py`.
"""
from __future__ import annotations

import json
import math
import time
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from functools import partial
from itertools import count
from pathlib import Path

from kei_exp.kie.extract import progress
from kei_exp.kie.extract.assembly import (ARTICLE_VERSION, artifact, document_values, ground_records,
                                          grounding_accounting, unchecked)
from kei_exp.kie.extract.calls import Call, complete
from kei_exp.kie.extract.contexts import (GROUPING_VERSION, Context, assemble_document, partition, reconcile_values,
                                          sharing)
from kei_exp.kie.extract.llm import Chat
from kei_exp.kie.extract.method import REFERENCE, ArticleOptions, LimitedCounter
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.rendering import RENDERING_VERSION, structured_source
from kei_exp.kie.extract.routing import VERSION as GROUNDING_ROUTING_VERSION, value_origins
from kei_exp.kie.extract.spans import VERSION as SPAN_GROUNDING_VERSION
from kei_exp.kie.extract.schema import SCALAR_JSON, Schema, conform, json_schema
from kei_exp.kie.extract.selection import VERSION as SELECTION_VERSION
from kei_exp.kie.extract.selection import select_contexts
from kei_exp.kie.extract.stages import (REPLY_TOKENS, Issue, Link, _instruction, _labelled, extract_record, normal,
                                        record_request, leaves)
from kei_exp.kie.extract.tokens import BudgetUnavailable, TokenCounter, counters_for
from kei_exp.kie.passages import Evidence, Passage, text_of
from kei_exp.workflows.cancel import CancelCheck

# The one document identity's label, shown where a record's identity would be (grounding); no identity attribute.
DOCUMENT_LABEL = "the whole document"


class RootUnanswered(ValueError):
    """No value context's call answered the document's root (each reply was cut off or unreadable, or the request was
    refused before it was sent), so there is no root to publish: an all-null one would read as a document that states
    nothing. Never published; the worker reports it as `extraction_failed`, its reason starting
    `article_root_unanswered:`. Some contexts answering is a partial root, with each failed context's `call_failed`."""


@dataclass
class Records:
    identities: list[dict]
    slices: list[tuple[list[Passage], dict]]
    calls: list[Call]
    issues: list[Issue]
    conflicts: list[dict]
    value_contexts: list[list[Context]]
    selections: list[dict]
    origins: list[list[dict]]


def extract(run_dir: Path | None, evidence: Evidence, request, chat: Router, *, counter: dict | None = None,
            chunks: int = 1, before_entry: Callable[[], None] | None = None,
            extraction_id: str | None = None) -> dict:
    """The Article artifact for `request` (the validated `run.ExtractRequest`) over `evidence`.

    The result is exactly one record, the document's root (`run.dispatch` holds it to that); when no value context
    answered the root, `RootUnanswered` is raised before grounding instead. Both roles need a served context size:
    `counter` is one counter per role, by default the counter of each role's endpoint. `before_entry` is called before
    each context's document-level call, each value context's call, the root's verification and each grounding batch,
    and, with bounded contexts, before each count that sizes a context and the selection; what it raises ends the
    extraction. `chunks` is not used: Article runs unsplit. With `run_dir` and `extraction_id`, the header, each value
    context's answered fields with the root assembled so far, and each grounding batch's links are published under the
    extraction directory for the partial view (design §2), each after `before_entry` again, unthrottled, so a cancel
    issued during the call just returned writes nothing that would refresh the run's garbage-collection age;
    `options.start_page` orders bounded value contexts, nearest first."""
    check = before_entry or unchecked
    strict = partial(check, force=True) if isinstance(check, CancelCheck) else check
    started = datetime.now(UTC).isoformat()
    clock = time.monotonic()
    schema = request.schema_
    options = request.options
    method = options.article or REFERENCE
    directory = run_dir / "extractions" / extraction_id if run_dir is not None and extraction_id else None
    execution = progress.started(directory, "article", options.start_page) if directory is not None else None
    contexts = [Context(evidence.passages)]
    if counter is None:
        counter = counters_for(chat)
    for role in ("fields", "reasoning"):
        if type(counter[role].context_tokens) is not int or counter[role].context_tokens <= 0:
            raise BudgetUnavailable(f"Article requires the {role} endpoint's context size")
    if method.context == "bounded":
        counter = {role: LimitedCounter(each, method.context_tokens) for role, each in counter.items()}
        contexts = source_contexts(evidence.passages, schema, method, counter["reasoning"], check)
    document, document_conflicts, calls, issues = document_values(evidence, contexts, schema, chat,
        budget=options.record_chars, check=check, counter=counter["fields"],
        structured=method.rendering == "structured")
    extracted = document_root(evidence.passages, schema, chat, counters=counter,
                              record_chars=options.record_chars, check=check, method=method, contexts=contexts,
                              start_page=options.start_page,
                              on_context=(partial(_context_stage, directory, execution, strict)
                                          if directory is not None else None))
    if extracted.calls and not any(call.ok for call in extracted.calls):
        raise RootUnanswered(f"article_root_unanswered: none of the {len(extracted.value_contexts[0])} value "
                             f"context(s) answered the document's root; the last call failed: "
                             f"{extracted.calls[-1].error}")
    calls += extracted.calls
    issues += extracted.issues
    support = ground_records(extracted.slices, schema, chat, check=check, budget=options.record_chars,
        counter=counter["reasoning"], method=method, identities=extracted.identities, contexts=contexts,
        value_contexts=extracted.value_contexts, origins=extracted.origins,
        on_batch=partial(_grounding_stage, directory, execution, strict, count()) if directory is not None else None)
    links = support.links
    calls += support.calls
    issues += support.issues
    result = artifact(evidence, request, chat, started=started, clock=clock,
                      fields=[fields for _, fields in extracted.slices], document=document, links=links,
                      calls=calls, issues=issues)
    result["inventory"] = extracted.identities
    result["article_version"] = ARTICLE_VERSION
    # Every claim once, apart from the issues each routed check raised (a claim refused in five contexts is one claim).
    result["grounding"] = grounding_accounting(
        {("records", number, *path) for number, (_, fields) in enumerate(extracted.slices) for path, _ in leaves(fields)},
        {link.path for link in links}, support.issues, excluded={tuple(item["path"]): item["policy"] for item in support.skipped},
        disabled=method.grounding == "off")
    if options.article is not None:  # the reference artifact carries no method fields
        result["method_version"] = 1
        result["contexts"] = [context.dumped() for context in contexts]
        result["value_contexts"] = [[context.dumped() for context in group] for group in extracted.value_contexts]
        result["quoted_support"] = support.proofs
        if method.grounding == "spans":
            result["span_grounding_version"] = SPAN_GROUNDING_VERSION
        if method.grounding_routing is not None:
            result["grounding_routing_version"] = GROUNDING_ROUTING_VERSION
            result["value_origins"] = [{**item, "path": ["records", number, *item["path"]]}
                for number, origins in enumerate(extracted.origins) for item in origins]
            result["grounding_routes"] = support.routes
        if method.rendering is not None:
            result["rendering_version"] = RENDERING_VERSION
        if method.grouping is not None:
            result["grouping_version"] = GROUPING_VERSION
        if method.selection is not None:
            result["selection_version"] = SELECTION_VERSION
            result["selections"] = extracted.selections
        result["conflicts"] = {"document": document_conflicts, "records": extracted.conflicts}
        result["completion"] = {
            "processing": all(call.ok for call in calls),
            "source_coverage": "attempted" if all(call.ok for call in calls if call.stage == "record") else "partial",
            "grounding": "disabled" if method.grounding == "off" else (
                "complete" if not result["ungrounded"] else "partial"),
            "record_recall": "unmeasured", "document_fields": "unverified" if schema.document_nodes else "not_applicable"}
        if method.evidence_policy == "schema":
            all_paths = {("records", number, *path) for number, (_, fields) in enumerate(extracted.slices)
                         for path, _ in leaves(fields)}
            eligible = all_paths - {tuple(item["path"]) for item in support.skipped}
            result["grounding_eligibility"] = {"all_record_leaves": len(all_paths),
                "eligible_record_leaves": len(eligible), "skipped": support.skipped}
            result["completion"]["eligible_grounding"] = (
                "not_applicable" if not eligible else "complete" if eligible <= {link.path for link in links} else "partial")
        # Successful calls and linked returned fields cannot establish that every array item was found.
        result["complete"] = False
    return result


def _context_stage(directory: Path, execution: str, check: Callable[[], None], index: int, total: int, answered: int,
                   failed: int, group: Context, fields: dict, root: dict, contested: list[dict], ok: bool,
                   calls: list[Call]) -> None:
    """One value context's answered fields and the root assembled so far, for the partial view (design §2); read by
    no path of this module. `ok` is false when this context's call failed; `failed` counts every failed context so far,
    so the latest file alone says whether unknown fields remain even when an earlier file's write was dropped. `check`
    runs first: what it raises (a cancel issued during the call) ends the extraction before anything is written."""
    check()
    progress.write_stage(directory / progress.context_name(index), {
        "version": progress.ARTICLE_STAGE_VERSION, "execution": execution, "context": index, "of": total,
        "answered": answered, "failed": failed, "passages": group.dumped(), "fields": fields, "root": root,
        "contested": contested, "ok": ok, "calls": [asdict(call) for call in calls]})


def _grounding_stage(directory: Path, execution: str, check: Callable[[], None], batches: count,
                     links: Sequence[Link]) -> None:
    """The links one grounding batch made, as the artifact writes a link (`assembly.artifact`), after `check`."""
    check()
    progress.write_stage(directory / progress.grounding_name(next(batches)), {
        "version": progress.ARTICLE_STAGE_VERSION, "execution": execution,
        "links": [{**asdict(link), "path": list(link.path), "bbox_pt": list(link.bbox_pt)} for link in links]})


def _answered(attempts: Sequence[Call]) -> bool:
    """A value context answered when its final attempt did, as `calls.complete` judges a reply: a structured request the
    server refused before the attempt that answered stays in the context's calls, never makes it a failed context. A
    context that made no attempt answered nothing."""
    return bool(attempts) and attempts[-1].ok


def context_order(groups: Sequence[Context], start_page: int | None) -> list[int]:
    """Value contexts in the order they are called (design §4): nearest `start_page` first (a context's distance is
    its nearest page's), a context without a page last, ties in source order; without a start page, source order.
    Answers are assembled in source order whatever this returns."""
    def distance(index: int) -> tuple[float, int]:
        pages = [passage.page for passage in groups[index].passages]
        return (0.0 if start_page is None else min((abs(page - start_page) for page in pages), default=float("inf")),
                index)
    return sorted(range(len(groups)), key=distance)


def document_root(passages: Sequence[Passage], schema: Schema, chat: Chat, *, counters: dict,
                  record_chars: int, check: Callable[[], None], method: ArticleOptions = REFERENCE,
                  contexts: list[Context] | None = None, start_page: int | None = None,
                  on_context: Callable[..., None] | None = None) -> Records:
    """The document's one root, from each of its value contexts, assembled; grounding belongs to the shared path.

    The whole document is the object: no identity is inventoried or bound, and every record field is asked of every
    value context under `stages.DOCUMENT`. With bounded contexts the source is partitioned (with its overlap) to fit
    that request, and `selection` sees every passage as the identity's support. Several contexts' answers are
    assembled by `contexts.assemble_document`: every array item kept in context order, an equal item that contexts
    sharing an overlap passage both returned joined once (an `overlap_items_joined` issue), equal items from other
    contexts kept and named by a `possible_repeated_items` issue, a disagreeing scalar null with its conflict. With
    `on_context`, after each value context's call, the root assembled by `assemble_document` and conformed over the
    contexts answered so far is reported with its scalar conflicts and the number of those contexts whose call failed:
    the partial view's reading of the document before the last context answers."""
    structured = method.rendering == "structured"
    item = {"identity": {}, "label": DOCUMENT_LABEL, "passages": [p.id for p in passages]}
    issues: list[Issue] = []
    calls = []
    selections = []
    groups = contexts if contexts is not None else [Context(tuple(passages))]
    if method.context == "bounded":
        def fits(group):
            check()
            source = structured_source(group) if structured else text_of(group)
            system, user, reply_schema = record_request(source, schema, None, None, document=True)
            counted = counters["fields"].request_tokens(system, user, reply_schema)
            # A context's root restates what the context gives: its reply keeps as many tokens as its request counts.
            return counted + max(REPLY_TOKENS, counted) <= counters["fields"].context_tokens
        groups = partition(passages, fits, overlap=method.overlap_passages,
                           structural=method.grouping == "structural") or [Context(())]
    if method.selection is not None and item["passages"]:
        check()
        groups, selection = select_contexts(groups, passages, item["passages"], schema)
        selections.append({"record": 0, **selection})
    candidates: list[dict] = [{} for _ in groups]
    answered: list[tuple[list[Call], list[Issue]] | None] = [None] * len(groups)
    for index in context_order(groups, start_page):
        group = groups[index]
        check()
        fields, attempts, problems = extract_record(group.passages, schema, chat, budget=record_chars, record=0,
            counter=counters["fields"], structured=structured, document=True)
        candidates[index], answered[index] = fields, (attempts, problems)
        if on_context is not None:
            done = [number for number, each in enumerate(answered) if each is not None]  # source order
            so_far, conflicts, _, _ = (assemble_document([candidates[number] for number in done],
                                                         sharing([groups[number] for number in done]))
                                       if len(done) != 1 else (candidates[done[0]], [], [], []))
            failed = sum(not _answered(answered[number][0]) for number in done)  # cumulative
            on_context(index, len(groups), len(done), failed, group, fields, conform(so_far, schema.record_nodes),
                       conflicts, _answered(attempts), attempts)
    for each in answered:  # calls and issues in source order: the artifact is the same whatever the order of work
        if each is not None:
            calls += each[0]
            issues += each[1]
    root, contested, repeats, joined = (assemble_document(candidates, sharing(groups)) if len(candidates) != 1
                                        else (candidates[0], [], [], []))
    root = conform(root, schema.record_nodes)
    # Every claim is grounded first where its value was read (`assembly.ground_records`), whatever `grounding_routing`
    # says (retired: it only still adds the routing diagnostics to the artifact). A value `conform` coerced has no
    # origin, so it is routed by value match and relevance alone, never refused (`strict`).
    origins = [value_origins(candidates, root, {}, item["passages"], strict=False)]
    issues += [Issue("conflicting_values", json.dumps(conflict, ensure_ascii=False), 0) for conflict in contested]
    issues += [Issue("possible_repeated_items", json.dumps(repeat, ensure_ascii=False), 0,
                     ("records", 0, *repeat["path"])) for repeat in repeats]
    issues += [Issue("overlap_items_joined", json.dumps(join, ensure_ascii=False), 0, ("records", 0, *join["path"]))
               for join in joined]
    return Records([item], [(list(passages), root)], calls, issues,
                   [{"record": 0, **conflict} for conflict in contested], [groups], selections, origins)


def extract_records(passages: Sequence[Passage], schema: Schema, chat: Chat, *, counters: dict,
                    record_chars: int, check: Callable[[], None], method: ArticleOptions = REFERENCE,
                    contexts: list[Context] | None = None) -> Records:
    """Discover identities, then extract their values; grounding belongs to the shared result path."""
    groups = contexts if contexts is not None else [Context(tuple(passages))]
    structured = method.rendering == "structured"
    identities, calls, issues = [], [], []
    for group in groups:
        check()
        found, attempts, problems = inventory(group.passages, schema, chat, counter=counters["reasoning"],
                                              method=method)
        identities += found
        calls += attempts
        # An empty source unit is ordinary; a document with no records is reported below.
        issues += [p for p in problems if len(groups) == 1 or p.code != "no_records_found"]
    if len(groups) > 1:
        identities, problems = reconcile_identities(identities, method)
        issues += problems
    if not identities and not any(p.code == "no_records_found" for p in issues):
        issues.append(Issue("no_records_found", "no source unit returned an identity"))
    slices = []
    conflicts = []
    value_contexts = []
    selections = []
    origins = []
    for number, item in enumerate(identities):
        candidates = []
        record_groups = groups
        neutral = method.prompt == "schema"
        if method.context == "bounded":
            def fits(group):
                check()
                source = structured_source(group) if structured else text_of(group)
                system, user, reply_schema = record_request(source, schema, item["identity"], item["label"],
                                                            neutral=neutral)
                return counters["fields"].request_tokens(system, user, reply_schema) + 4096 <= counters["fields"].context_tokens
            record_groups = partition(passages, fits, overlap=method.overlap_passages,
                                      structural=method.grouping == "structural")
        if method.selection is not None:
            check()
            record_groups, selection = select_contexts(record_groups, passages, item["passages"], schema)
            selections.append({"record": number, **selection})
        value_contexts.append(record_groups)
        for group in record_groups:
            check()
            fields, attempts, problems = extract_record(group.passages, schema, chat, budget=record_chars,
                record=number, identity=item["identity"], record_name=item["label"], counter=counters["fields"],
                neutral=neutral, structured=structured)
            calls += attempts
            issues += problems
            candidates.append(fields)
        fields, contested = reconcile_values(candidates) if len(record_groups) != 1 else (candidates[0], [])
        if method.grounding_routing is not None:
            origins.append(value_origins(candidates, fields, item["identity"], item["passages"]))
        conflicts += [{"record": number, **conflict} for conflict in contested]
        issues += [Issue("conflicting_values", json.dumps(conflict, ensure_ascii=False), number)
                   for conflict in contested]
        slices.append((list(passages), fields))
    return Records(identities, slices, calls, issues, conflicts, value_contexts, selections, origins)


def inventory_request(passages: Sequence[Passage], schema: Schema, method: ArticleOptions = REFERENCE):
    labels = [p.id for p in passages]
    identity_nodes = {node.name: node for node in schema.record_nodes if node.type in SCALAR_JSON}
    if method.identity == "conservative":
        identity_nodes = {name: identity_nodes[name] for name in method.identity_fields}
    properties = json_schema(list(identity_nodes.values()))["properties"]
    item = {"type": "object", "properties": {
        "label": {"type": "string"},
        "identity": {"type": "object", "properties": properties, "additionalProperties": False},
        "passages": {"type": "array", "items": {"type": "string", "enum": labels}}},
        "required": ["label", "identity", "passages"], "additionalProperties": False}
    reply_schema = {"type": "object", "properties": {"records": {"type": "array", "items": item}},
                    "required": ["records"], "additionalProperties": False}
    system = ("Enumerate EVERY distinct record supported by this source under the record definition. This is an "
              "identity inventory, not a summary and not values extraction. Read the tables as well as prose. "
              "Include measured starting materials, separate final preparations/fractions and comparison controls "
              "when the definition includes them, even if few requested measurements are available. A record "
              "recurring across sections appears once; distinct table rows or columns describing distinct "
              "samples remain distinct. Do not turn proposed methods, group averages or unconfirmed types into "
              "additional samples. Do not enumerate background references. Identify each record unambiguously "
              "using an identity object with schema field names for ALL identity dimensions, including its final "
              "preparation label (or the schema's label for raw/unresolved material), and cite the passage IDs "
              "establishing it AND ALL passages reporting its measurements, shared methods, qualifications or "
              "contradictory conclusions. Include every relevant table and its caption/footnotes. The value "
              "extractor reads the complete source; these citations establish each record's identity and scope. "
              "Give each record an unambiguous descriptive label. Identity fields are fixed for the later value "
              "extractor: include only source-supported identity "
              "attributes, not measurements, protocols or notes. Use the exact labels specified by the schema "
              "(a scope code and a preparation label can differ). "
              "Resolve abbreviations from the source. Never use an expected count or a "
              "validation list. Return JSON.\n" + _instruction(schema, schema.record_nodes))
    user = structured_source(passages) if method.rendering == "structured" else _labelled(passages, labels)
    if method.prompt == "schema":
        system = ("Enumerate every distinct record supported by the supplied source unit under the schema's record "
                  "definition. Records may recur across other units. Return an unambiguous label, source-supported "
                  "identity attributes using only offered field names, and IDs of passages establishing the identity "
                  "or its attributes. Do not invent attributes to distinguish records. Distinct subjects sharing a name "
                  "remain separate. Include only records defined by the schema, never background references. "
                  "Identity fields will bind subsequent extraction. Return JSON.\n" + _instruction(schema, schema.record_nodes))
    return system, user, reply_schema, identity_nodes


def source_contexts(passages: Sequence[Passage], schema: Schema, method: ArticleOptions, counter: TokenCounter,
                    check: Callable[[], None]) -> list[Context]:
    def fits(group):
        check()
        system, user, reply_schema, _ = inventory_request(group, schema, method)
        return counter.request_tokens(system, user, reply_schema) + 4096 <= counter.context_tokens
    return partition(passages, fits, overlap=method.overlap_passages,
                     structural=method.grouping == "structural") or [Context(())]


def inventory(passages: Sequence[Passage], schema: Schema, chat: Chat, *, counter: TokenCounter,
              method: ArticleOptions = REFERENCE) -> tuple[list[dict], list[Call], list[Issue]]:
    """Article identities recur across sections; they are not contiguous Catalog slices."""
    issues: list[Issue] = []
    if not passages:
        return [], [], [Issue("no_records_found", "the source has no readable passages")]
    system, user, reply_schema, identity_nodes = inventory_request(passages, schema, method)
    labels = [p.id for p in passages]
    available = (counter.context_tokens or 0) - counter.request_tokens(system, user, reply_schema)
    # Enumeration can be larger than one record. Keep at least 4096 output tokens or refuse the input;
    # otherwise use the available context up to the adapters' ordinary 8192-token output allowance.
    output_tokens = 4096 if method.context == "bounded" else max(4096, min(8192, available))
    answer, attempts = complete(chat, stage="inventory", record=None, system=system,
        user=user, schema=reply_schema, counter=counter, max_tokens=output_tokens)
    if not attempts[-1].ok:
        return [], attempts, [Issue("call_failed", attempts[-1].error or "Article inventory failed")]
    found = answer.get("records") if isinstance(answer, dict) else None
    records = []
    seen = {}
    for item in found if isinstance(found, list) else []:
        label = item.get("label") if isinstance(item, dict) else None
        attributes = item.get("identity") if isinstance(item, dict) else None
        support = item.get("passages") if isinstance(item, dict) else None
        identity = {}
        valid = isinstance(attributes, dict)
        if isinstance(attributes, dict):
            for name, value in attributes.items():
                if name not in identity_nodes:
                    valid = False
                    break
                node = identity_nodes[name]
                if value is None:
                    continue  # unknown attributes do not bind a later extractor or discard the sample
                types = {"string": (str,), "verbatim-string": (str,), "date": (str,), "integer": (int,),
                         "number": (int, float), "boolean": (bool,)}[node.type]
                if type(value) not in types or (isinstance(value, str) and not value.strip()) or (
                        type(value) in (int, float) and not math.isfinite(value)) or (
                        node.allowed_values is not None and value not in node.allowed_values):
                    valid = False
                    break
                identity[name] = value
        if not valid or not isinstance(label, str) or not label.strip() or not isinstance(support, list) or not support \
                or any(not isinstance(ref, str) or ref not in labels for ref in support):
            issues.append(Issue("invalid_inventory_record", "record needs an identity and canonical passage IDs"))
            continue
        key = json.dumps({name: normal(value) if isinstance(value, str) else value for name, value in identity.items()},
                         sort_keys=True) if identity else normal(label)
        if method.identity == "conservative":
            key = identity_key({"label": label, "identity": identity, "passages": support}, method)
            if not all(name in identity for name in method.identity_fields):
                issues.append(Issue("partial_identity", f"unresolved identity dimensions for {label}"))
        if key in seen:
            previous = records[seen[key]]
            previous["passages"] = list(dict.fromkeys([*previous["passages"], *support]))
            if normal(label) != normal(previous["label"]):
                previous["label"] += f"; {label}"
            issues.append(Issue("duplicate_inventory_record", f"combined supporting passages for {key}"))
            continue
        seen[key] = len(records)
        records.append({"label": label, "identity": identity, "passages": list(dict.fromkeys(support))})
    if not records:
        issues.append(Issue("no_records_found", "the model returned no supported record identity"))
    return records, attempts, issues


def identity_key(item: dict, method: ArticleOptions = REFERENCE) -> str:
    identity = {key: normal(value) if isinstance(value, str) else value for key, value in item["identity"].items()}
    # A complete explicitly declared key permits cross-unit reconciliation. Partial keys
    # never erase distinct labels or mentions; uncertainty is visible as separate records.
    complete = all(key in identity for key in method.identity_fields)
    key = identity if complete else {"identity": identity, "label": normal(item["label"]),
                                    "support": sorted(set(item["passages"]))}
    return json.dumps(key, sort_keys=True, ensure_ascii=False)


def reconcile_identities(items: list[dict], method: ArticleOptions = REFERENCE) -> tuple[list[dict], list[Issue]]:
    records, seen, issues = [], {}, []
    for item in items:
        if method.identity == "conservative":
            key = identity_key(item, method)
            if not all(field in item["identity"] for field in method.identity_fields):
                issues.append(Issue("partial_identity", f"unresolved identity dimensions for {item['label']}"))
        else:
            key = json.dumps({k: normal(v) if isinstance(v, str) else v for k, v in item["identity"].items()},
                             sort_keys=True) if item["identity"] else normal(item["label"])
        if key in seen:
            previous = records[seen[key]]
            previous["passages"] = list(dict.fromkeys([*previous["passages"], *item["passages"]]))
        else:
            seen[key] = len(records)
            records.append(dict(item))
    return records, issues
