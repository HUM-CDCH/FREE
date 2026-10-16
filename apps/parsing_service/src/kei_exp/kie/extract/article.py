"""Article: the document-scope extraction, one document-level object that may contain arrays.

`extract` is the Article implementation: the document's one root read in each of its value contexts (the complete
source by default, bounded parts with `options.article.context` or when the whole source does not fit one call),
assembled across them by `contexts.assemble_document`, resolved by `resolution.resolve`, verified in every source
context, and the artifact assembled in `assembly.py`, as the version 1 Catalog's is (`document_root`). No identity
is inventoried: the artifact's `inventory`
holds the one document identity, every passage its support. The preliminary context budget still counts
`inventory_request` without sending it. Historical identity extraction lives in
`experiments.extraction.legacy_article` for research replays of captured version 1 studies. Every model call goes
through `calls.complete`; the shared value prompts live in `stages.py` and grounding in `grounding.py`.
"""
from __future__ import annotations

import json
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from kei_exp.kie.extract.assembly import (ARTICLE_VERSION, artifact, document_values, ground_records,
                                          grounding_accounting, link_json)
from kei_exp.kie.extract.calls import Call
from kei_exp.kie.extract.contexts import (GROUPING_VERSION, Context, assemble_document, partition,
                                          sharing, value_disagreements)
from kei_exp.kie.extract.llm import Chat
from kei_exp.kie.extract.method import REFERENCE, ArticleOptions, LimitedCounter
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.rendering import RENDERING_VERSION, structured_source
from kei_exp.kie.extract.resolution import resolve
from kei_exp.kie.extract.routing import VERSION as GROUNDING_ROUTING_VERSION, value_origins
from kei_exp.kie.extract.spans import VERSION as SPAN_GROUNDING_VERSION
from kei_exp.kie.extract.schema import SCALAR_JSON, Schema, conform, json_schema, typed
from kei_exp.kie.extract.selection import VERSION as SELECTION_VERSION
from kei_exp.kie.extract.selection import select_contexts
from kei_exp.kie.extract.stages import (REPLY_TOKENS, Issue, _instruction, _labelled, extract_record,
                                        record_request, leaves)
from kei_exp.kie.extract.tokens import BudgetUnavailable, TokenCounter, counters_for
from kei_exp.kie.passages import Evidence, Passage, text_of

# The one document identity's label, shown where a record's identity would be (grounding); no identity attribute.
DOCUMENT_LABEL = "the whole document"


class RootUnanswered(ValueError):
    """No value context's call answered the document's root (each reply was cut off or unreadable, or the request was
    refused before it was sent), so there is no root to publish: an all-null one would read as a document that states
    nothing. Never retained; its message starts `article_root_unanswered:`. Some contexts answering is a partial root, with each failed context's `call_failed`."""


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
    disagreements: list[dict] = field(default_factory=list)


def _read_in(found, groups):
    """Each alternative's value and the segments of every context that read it, in source order."""
    return [{**entry, "alternatives": [{"value": alternative["value"], "segments": list(dict.fromkeys(
        p.id for index in alternative["readings"] for p in (*groups[index].overlap, *groups[index].primary)))}
        for alternative in entry["alternatives"]]} for entry in found]


def _typed_reading(answer: dict, nodes) -> tuple[dict, list[Issue]]:
    """One context's answer with each scalar outside a list of its declared type (a whole-number float an integer)
    and any other null, with its `invalid_value` issue: an invalid reading never conflicts with a valid one."""
    issues = []

    def typed_fields(value, nodes, path):
        fields = dict(value)
        for node in nodes:
            item = value.get(node.name)
            if node.type == "object" and isinstance(item, dict):
                fields[node.name] = typed_fields(item, node.children or [], [*path, node.name])
            elif node.type not in ("object", "array") and item is not None:
                if type(item) is float and item.is_integer():
                    item = int(item)
                if not typed(item, node):
                    issues.append(Issue("invalid_value", json.dumps({"path": [*path, node.name], "value": item},
                                                                    ensure_ascii=False), 0))
                    item = None
                fields[node.name] = item
        return fields
    return typed_fields(answer, nodes, []), issues


def extract(run_dir: Path | None, evidence: Evidence, request, chat: Router, *, counter: dict | None = None,
            chunks: int = 1) -> dict:
    """The Article artifact for `request` (the validated `run.ExtractRequest`) over `evidence`.

    The result is exactly one record, the document's root (`run.dispatch` holds it to that); when no value context
    answered the root, `RootUnanswered` is raised before grounding instead. Both roles need a served context size:
    `counter` is one counter per role, by default the counter of each role's endpoint. `chunks` and `run_dir` are
    not used: Article runs unsplit and publishes nothing itself; each answered value context is handed to the durable
    retained-result producer (`retained.saved_record`). `options.start_page` orders bounded value contexts, nearest
    first."""
    started = datetime.now(UTC).isoformat()
    clock = time.monotonic()
    schema = request.schema_
    options = request.options
    method = options.article or REFERENCE
    contexts = [Context(evidence.passages)]
    if counter is None:
        counter = counters_for(chat)
    for role in ("fields", "reasoning"):
        if type(counter[role].context_tokens) is not int or counter[role].context_tokens <= 0:
            raise BudgetUnavailable(f"Article requires the {role} endpoint's context size")
    fallback = None
    if method.context == "full":
        source = (structured_source(evidence.passages) if method.rendering == "structured"
                  else text_of(evidence.passages))
        counted = counter["fields"].request_tokens(*record_request(source, schema, None, None, document=True))
        served = counter["fields"].context_tokens
        if counted + REPLY_TOKENS > served:
            # A document too long for one root call is read in bounded parts of the served context instead of failing.
            method = method.model_copy(update={"context": "bounded", "grouping": None,
                                               "context_tokens": min(served, counter["reasoning"].context_tokens)})
            fallback = Issue("context_fallback", f"the whole document's root request counts {counted} tokens, more "
                             f"than its {served}-token context leaves beside a {REPLY_TOKENS}-token reply; it is read "
                             f"in bounded parts of {method.context_tokens} tokens")
    if method.context == "bounded":
        counter = {role: LimitedCounter(each, method.context_tokens) for role, each in counter.items()}
        contexts = source_contexts(evidence.passages, schema, method, counter["reasoning"])
    from kei_exp.kie.extract.retained import plan_records
    # Retry keeps its generation: a pre-fallback attempt may already have saved the one-part plan before failing
    # admission. Keep that plan immutable and publish fallback scopes separately; call captures still reuse their
    # unchanged inputs, independently of this context listing.
    context_stage = "article-contexts:fallback" if fallback is not None else "article-contexts"
    plan_records(chat, context_stage, [context.dumped() for context in contexts])
    document, document_conflicts, calls, issues = document_values(evidence, contexts, schema, chat,
        budget=options.record_chars, counter=counter["fields"],
        structured=method.rendering == "structured")
    if fallback is not None:
        issues.append(fallback)
    def retained_context(*args):
        index, total, answered, failed, group, fields, root, disagreements, ok, context_calls = args
        if ok:
            from kei_exp.kie.extract.retained import saved_record
            saved_record(chat, root, "document", primary=[{"segment": p.id, "start": 0, "end": len(p.text)}
                                                         for p in group.primary], disagreements=disagreements)
    extracted = document_root(evidence.passages, schema, chat, counters=counter,
                              record_chars=options.record_chars, method=method, contexts=contexts,
                              start_page=options.start_page,
                              on_context=retained_context)
    if extracted.calls and not any(call.ok for call in extracted.calls):
        raise RootUnanswered(f"article_root_unanswered: none of the {len(extracted.value_contexts[0])} value "
                             f"context(s) answered the document's root; the last call failed: "
                             f"{extracted.calls[-1].error}")
    calls += extracted.calls
    issues += extracted.issues
    if len(extracted.value_contexts[0]) > 1:
        from kei_exp.kie.extract.retained import saved_record
        saved_record(chat, extracted.slices[0][1], "document", disagreements=extracted.disagreements)
    grounded: list = []
    def retained_links(batch):
        # Each grounding batch's links are retained at once, so the source shows them while the run goes on.
        grounded.extend(batch)
        if batch:
            from kei_exp.kie.extract.retained import saved_record
            saved_record(chat, extracted.slices[0][1], "document", links=[link_json(link) for link in grounded],
                         disagreements=extracted.disagreements)
    support = ground_records(extracted.slices, schema, chat, budget=options.record_chars,
        counter=counter["reasoning"], method=method, identities=extracted.identities, contexts=contexts,
        value_contexts=extracted.value_contexts, origins=extracted.origins, on_batch=retained_links)
    links = support.links
    calls += support.calls
    issues += support.issues
    result = artifact(evidence, request, chat, started=started, clock=clock,
                      fields=[fields for _, fields in extracted.slices], document=document, links=links,
                      calls=calls, issues=issues)
    if extracted.disagreements:
        result["disagreements"] = extracted.disagreements
    result["inventory"] = extracted.identities
    result["article_version"] = ARTICLE_VERSION
    # Every claim once, apart from the issues each routed check raised (a claim refused in five contexts is one claim).
    all_paths = {("records", number, *path) for number, (_, fields) in enumerate(extracted.slices) for path, _ in leaves(fields)}
    disagreeing = {("records", 0, *entry["names"]) for entry in extracted.disagreements}
    result["grounding"] = grounding_accounting(
        all_paths,
        {link.path for link in links}, support.issues, excluded={tuple(item["path"]): item["policy"] for item in support.skipped},
        disabled=method.grounding == "off", disagreeing=disagreeing)
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
            "processing": all(call.ok or call.recovered for call in calls),
            "source_coverage": "attempted" if all(call.ok for call in calls if call.stage == "record") else "partial",
            "grounding": "disabled" if method.grounding == "off" else (
                "complete" if not result["ungrounded"] and not disagreeing else "partial"),
            "record_recall": "unmeasured", "document_fields": "unverified" if schema.document_nodes else "not_applicable"}
        if method.evidence_policy == "schema":
            eligible = all_paths - {tuple(item["path"]) for item in support.skipped}
            result["grounding_eligibility"] = {"all_record_leaves": len(all_paths),
                "eligible_record_leaves": len(eligible), "skipped": support.skipped}
            result["completion"]["eligible_grounding"] = (
                "partial" if disagreeing else "not_applicable" if not eligible else "complete" if eligible <= {link.path for link in links} else "partial")
        # Successful calls and linked returned fields cannot establish that every array item was found.
        result["complete"] = False
    return result


def _answered(attempts: Sequence[Call]) -> bool:
    """A value context answered when its final attempt did, as `calls.complete` judges a reply: a structured request the
    server refused before the attempt that answered stays in the context's calls, never makes it a failed context. A
    context that made no attempt answered nothing."""
    return bool(attempts) and attempts[-1].ok


def context_order(groups: Sequence[Context], start_page: int | None) -> list[int]:
    """Value contexts in the order they are called (service README, start_page): nearest `start_page` first (a
    context's distance is its nearest page's), a context without a page last, ties in source order; without a start
    page, source order. Answers are assembled in source order whatever this returns."""
    def distance(index: int) -> tuple[float, int]:
        pages = [passage.page for passage in groups[index].passages]
        return (0.0 if start_page is None else min((abs(page - start_page) for page in pages), default=float("inf")),
                index)
    return sorted(range(len(groups)), key=distance)


def document_root(passages: Sequence[Passage], schema: Schema, chat: Chat, *, counters: dict,
                  record_chars: int, method: ArticleOptions = REFERENCE,
                  contexts: list[Context] | None = None, start_page: int | None = None,
                  on_context: Callable[..., None] | None = None, resolve_parts: bool = True) -> Records:
    """The document's one root, from each of its value contexts, assembled; grounding belongs to the shared path.

    The whole document is the object: no identity is inventoried or bound, and every record field is asked of every
    value context under `stages.DOCUMENT`. With bounded contexts the source is partitioned (with its overlap) to fit
    that request, and `selection` sees every passage as the identity's support. A scalar not of its field's type is
    null in its context's answer (`_typed_reading`). Several contexts' answers are
    assembled by `contexts.assemble_document`: every array item kept in context order, an equal item that contexts
    sharing an overlap passage both returned joined once (an `overlap_items_joined` issue), equal items from other
    contexts kept and named by a `possible_repeated_items` issue, a disagreeing scalar null with its conflict.
    A split source is then resolved over those assembled occurrences;
    `resolve_parts=False` replays artifacts before `ARTICLE_VERSION` 12, which made no resolution call. With
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
            source = structured_source(group) if structured else text_of(group)
            system, user, reply_schema = record_request(source, schema, None, None, document=True)
            counted = counters["fields"].request_tokens(system, user, reply_schema)
            # A context's root restates what the context gives: its reply keeps as many tokens as its request counts.
            return counted + max(REPLY_TOKENS, counted) <= counters["fields"].context_tokens
        groups = partition(passages, fits, overlap=method.overlap_passages,
                           structural=method.grouping == "structural") or [Context(())]
    if method.selection is not None and item["passages"]:
        groups, selection = select_contexts(groups, passages, item["passages"], schema)
        selections.append({"record": 0, **selection})
    candidates: list[dict] = [{} for _ in groups]
    answered: list[tuple[list[Call], list[Issue]] | None] = [None] * len(groups)
    for index in context_order(groups, start_page):
        group = groups[index]
        fields, attempts, problems = extract_record(group.passages, schema, chat, budget=record_chars, record=0,
            counter=counters["fields"], structured=structured, document=True,
            bounded_document=method.context == "bounded")
        fields, invalid = _typed_reading(fields, schema.record_nodes)
        candidates[index], answered[index] = fields, (attempts, problems + invalid)
        if on_context is not None:
            done = [number for number, each in enumerate(answered) if each is not None]  # source order
            so_far, conflicts, _, _ = (assemble_document([candidates[number] for number in done],
                                                         sharing([groups[number] for number in done]))
                                       if len(done) != 1 else (candidates[done[0]], [], [], []))
            failed = sum(not _answered(answered[number][0]) for number in done)  # cumulative
            on_context(index, len(groups), len(done), failed, group, fields, conform(so_far, schema.record_nodes),
                       _read_in(value_disagreements(candidates, conflicts, schema.record_nodes), groups),
                       _answered(attempts), attempts)
    for each in answered:  # calls and issues in source order: the artifact is the same whatever the order of work
        if each is not None:
            calls += each[0]
            issues += each[1]
    item_sources: dict[tuple, list[dict]] = {}
    root, contested, repeats, joined = (assemble_document(candidates, sharing(groups), item_sources=item_sources)
                                        if len(candidates) != 1
                                        else (candidates[0], [], [], []))
    if resolve_parts and len(groups) > 1 and any(each is not None and _answered(each[0]) for each in answered):
        root, contested, repeats, joined, resolved, settled = resolve(
            candidates, groups, root, contested, repeats, joined, schema, chat, counters["reasoning"],
            item_sources=item_sources)
        calls += resolved
        issues += settled
    root = conform(root, schema.record_nodes)
    # Every claim is grounded first where its value was read (`assembly.ground_records`), whatever `grounding_routing`
    # says (retired: it only still adds the routing diagnostics to the artifact). A value `conform` coerced has no
    # origin, so it is routed by value match and relevance alone, never refused (`strict`).
    origins = [value_origins(candidates, root, {}, item["passages"], strict=False,
                             item_sources=item_sources if len(candidates) != 1 else None)]
    issues += [Issue("conflicting_values", json.dumps(conflict, ensure_ascii=False), 0) for conflict in contested]
    issues += [Issue("possible_repeated_items", json.dumps(repeat, ensure_ascii=False), 0,
                     ("records", 0, *repeat["path"])) for repeat in repeats]
    issues += [Issue("overlap_items_joined", json.dumps(join, ensure_ascii=False), 0, ("records", 0, *join["path"]))
               for join in joined]
    return Records([item], [(list(passages), root)], calls, issues,
                   [{"record": 0, **conflict} for conflict in contested], [groups], selections, origins,
                   _read_in(value_disagreements(candidates, contested, schema.record_nodes), groups))


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


def source_contexts(passages: Sequence[Passage], schema: Schema, method: ArticleOptions,
                    counter: TokenCounter) -> list[Context]:
    def fits(group):
        system, user, reply_schema, _ = inventory_request(group, schema, method)
        return counter.request_tokens(system, user, reply_schema) + 4096 <= counter.context_tokens
    return partition(passages, fits, overlap=method.overlap_passages,
                     structural=method.grouping == "structural") or [Context(())]
