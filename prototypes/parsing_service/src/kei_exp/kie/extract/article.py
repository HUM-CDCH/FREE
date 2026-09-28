"""Article record discovery across noncontiguous source evidence.

Inventory owns identity validation and reconciliation. Shared model calls, schema rendering,
value extraction and grounding remain in their stage modules. The complete-source reference
is preserved for reproducible comparisons while bounded variants are developed.
"""
from __future__ import annotations

import json
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from kei_exp.kie.extract.contexts import Context, partition, reconcile_values
from kei_exp.kie.extract.evidence import Passage, text_of
from kei_exp.kie.extract.llm import Chat
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.rendering import structured_source
from kei_exp.kie.extract.routing import value_origins
from kei_exp.kie.extract.schema import SCALAR_JSON, Schema, json_schema
from kei_exp.kie.extract.selection import select_contexts
from kei_exp.kie.extract.stages import Call, Issue, _complete, _instruction, _labelled, extract_record, normal, record_request
from kei_exp.kie.extract.tokens import TokenCounter


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


def extract_records(passages: Sequence[Passage], schema: Schema, chat: Chat, *, counters: dict,
                    record_chars: int, check: Callable[[], None], method: ArticleOptions | None = None,
                    contexts: list[Context] | None = None) -> Records:
    """Discover identities, then extract their values; grounding belongs to the shared result path."""
    groups = contexts if contexts is not None else [Context(tuple(passages))]
    structured = method is not None and method.rendering == "structured"
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
        neutral = method is not None and method.prompt == "schema"
        if method is not None and method.context == "bounded":
            def fits(group):
                check()
                source = structured_source(group) if structured else text_of(group)
                system, user, reply_schema = record_request(source, schema, item["identity"], item["label"],
                                                            neutral=neutral)
                return counters["fields"].request_tokens(system, user, reply_schema) + 4096 <= counters["fields"].context_tokens
            record_groups = partition(passages, fits, overlap=method.overlap_passages,
                                      structural=method.grouping == "structural")
        if method is not None and method.selection is not None:
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
        if method is not None and method.grounding_routing is not None:
            origins.append(value_origins(candidates, fields, item["identity"], item["passages"]))
        conflicts += [{"record": number, **conflict} for conflict in contested]
        issues += [Issue("conflicting_values", json.dumps(conflict, ensure_ascii=False), number)
                   for conflict in contested]
        slices.append((list(passages), fields))
    return Records(identities, slices, calls, issues, conflicts, value_contexts, selections, origins)


def inventory_request(passages: Sequence[Passage], schema: Schema, method: ArticleOptions | None = None):
    labels = [p.id for p in passages]
    identity_nodes = {node.name: node for node in schema.record_nodes if node.type in SCALAR_JSON}
    if method is not None and method.identity == "conservative":
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
    user = (structured_source(passages) if method is not None and method.rendering == "structured"
            else _labelled(passages, labels))
    if method is not None and method.prompt == "schema":
        system = ("Enumerate every distinct record supported by the supplied source unit under the schema's record "
                  "definition. Records may recur across other units. Return an unambiguous label, source-supported "
                  "identity attributes using only offered field names, and IDs of passages establishing the identity "
                  "or its attributes. Do not invent attributes to distinguish records. Distinct subjects sharing a name "
                  "remain separate. Include only records defined by the schema, never background references. "
                  "Identity fields will bind subsequent extraction. Return JSON.\n" + _instruction(schema, schema.record_nodes))
    return system, user, reply_schema, identity_nodes


def source_contexts(passages, schema, method, counter, check):
    def fits(group):
        check()
        system, user, reply_schema, _ = inventory_request(group, schema, method)
        return counter.request_tokens(system, user, reply_schema) + 4096 <= counter.context_tokens
    return partition(passages, fits, overlap=method.overlap_passages,
                     structural=method.grouping == "structural") or [Context(())]


def inventory(passages: Sequence[Passage], schema: Schema, chat: Chat, *, counter: TokenCounter,
              method: ArticleOptions | None = None) -> tuple[list[dict], list[Call], list[Issue]]:
    """Article identities recur across sections; they are not contiguous Catalog slices."""
    issues: list[Issue] = []
    if not passages:
        return [], [], [Issue("no_records_found", "the source has no readable passages")]
    system, user, reply_schema, identity_nodes = inventory_request(passages, schema, method)
    labels = [p.id for p in passages]
    available = (counter.context_tokens or 0) - counter.request_tokens(system, user, reply_schema)
    # Enumeration can be larger than one record. Keep at least 4096 output tokens or refuse the input;
    # otherwise use the available context up to the adapters' ordinary 8192-token output allowance.
    output_tokens = 4096 if method is not None and method.context == "bounded" else max(4096, min(8192, available))
    answer, attempts = _complete(chat, stage="inventory", record=None, system=system,
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
        if method is not None and method.identity == "conservative":
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


def identity_key(item: dict, method: ArticleOptions) -> str:
    identity = {key: normal(value) if isinstance(value, str) else value for key, value in item["identity"].items()}
    # A complete explicitly declared key permits cross-unit reconciliation. Partial keys
    # never erase distinct labels or mentions; uncertainty is visible as separate records.
    complete = all(key in identity for key in method.identity_fields)
    key = identity if complete else {"identity": identity, "label": normal(item["label"]),
                                    "support": sorted(set(item["passages"]))}
    return json.dumps(key, sort_keys=True, ensure_ascii=False)


def reconcile_identities(items: list[dict], method: ArticleOptions) -> tuple[list[dict], list[Issue]]:
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
