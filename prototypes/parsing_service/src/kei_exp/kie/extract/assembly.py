"""The version 1 artifact, assembled the same way for Article and the version 1 Catalog.

Each strategy finds its records and reads their values its own way; what they share after that lives here: the
document-level values read in each context and reconciled across them, each record's values grounded through the
technique `grounding.technique` names, the records merged with the document and filename values, and the artifact's
common fields with its fingerprint. Document-level fields (`valueSource: document`) are extracted but not verified in
this slice, since grounding them would need the whole source's labels: the artifact names them under `unverified`,
and `complete` speaks for record values only.

`request` below is the validated `run.ExtractRequest`; this module reads its schema and options and does not import
`run`.
"""
from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass, field, replace

from kei_exp.canonical import canonical_json
from kei_exp.kie.extract import grounding
from kei_exp.kie.extract.contexts import GROUPING_VERSION, Context, reconcile_values
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.routing import VERSION as GROUNDING_ROUTING_VERSION, verify_routed
from kei_exp.kie.extract.spans import VERSION as SPAN_GROUNDING_VERSION
from kei_exp.kie.extract.rendering import RENDERING_VERSION
from kei_exp.kie.extract.schema import Schema, evidence_policy
from kei_exp.kie.extract.selection import VERSION as SELECTION_VERSION
from kei_exp.kie.extract.stages import Call, Issue, Link, extract_document, leaves, merge
from kei_exp.kie.extract.tokens import TokenCounter
from kei_exp.kie.passages import Evidence, Passage

EXTRACTION_VERSION = 1
PROMPT_VERSION = 12  # Lossless source-string decoding and coherent exact quoted grounding.


def fingerprint(result: dict, request, model: dict) -> str:
    """Over the parse generation and digest, the schema, the options, the model per role and the prompt version."""
    return hashlib.sha256(canonical_json({
        "generation": result["generation"], "digest": result["digest"],
        "schema": request.schema_.model_dump(by_alias=True, exclude_none=True),
        "options": request.options.dumped(), "model": model, "prompt_version": PROMPT_VERSION,
        **({"method_version": 1} if request.options.article is not None else {}),
        **({"rendering_version": RENDERING_VERSION} if request.options.article is not None
           and request.options.article.rendering is not None else {}),
        **({"grouping_version": GROUPING_VERSION} if request.options.article is not None
           and request.options.article.grouping is not None else {}),
        **({"selection_version": SELECTION_VERSION}
           if request.options.article is not None and request.options.article.selection is not None else {}),
        **({"span_grounding_version": SPAN_GROUNDING_VERSION}
           if request.options.article is not None and request.options.article.grounding == "spans" else {}),
        **({"grounding_routing_version": GROUNDING_ROUTING_VERSION}
           if request.options.article is not None and request.options.article.grounding_routing is not None else {}),
    })).hexdigest()


def unchecked() -> None:
    """No cancellation hook: the CLI and direct callers run to the end."""


def document_values(evidence: Evidence, contexts: Sequence[Context], schema: Schema, chat: Router, *, budget: int,
                    check: Callable[[], None], counter: TokenCounter | None = None, structured: bool = False
                    ) -> tuple[dict, list[dict], list[Call], list[Issue]]:
    """The document-level fields read in each context and reconciled across them, the conflicts, calls and issues.

    `check` runs before each context's call when the schema has document-level fields. A scalar the contexts disagree
    on is null, with its conflict and a `conflicting_document_values` issue."""
    documents: list[dict] = []
    calls: list[Call] = []
    issues: list[Issue] = []
    for context in contexts:
        if schema.document_nodes:
            check()
        document, document_calls, document_issues = extract_document(replace(evidence, passages=context.passages),
            schema, chat, budget=budget, counter=counter, structured=structured)
        documents.append(document)
        calls += document_calls
        issues += document_issues
    document, conflicts = reconcile_values(documents) if len(documents) > 1 else (documents[0], [])
    issues += [Issue("conflicting_document_values", json.dumps(conflict, ensure_ascii=False))
               for conflict in conflicts]
    return document, conflicts, calls, issues


@dataclass
class GroundingResult:
    links: list[Link] = field(default_factory=list)
    calls: list[Call] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    proofs: list[dict] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)
    routes: list[dict] = field(default_factory=list)


def ground_records(slices: Sequence[tuple[Sequence[Passage], dict]], schema: Schema, chat, *,
                   check: Callable[[], None], budget: int, counter=None,
                   method: ArticleOptions | None = None, identities: Sequence[dict] | None = None,
                   contexts: Sequence[Context] = (), value_contexts: Sequence[Sequence[Context]] = (),
                   origins: Sequence[Sequence[dict]] = ()) -> GroundingResult:
    """Keep input values fixed while evaluating support; hints never create evidence.

    Article supplies identities and complete source contexts. Generic Catalog uses
    the owned passages in each slice. Neither path extracts or reconciles values here.
    """
    result = GroundingResult()
    verifier = grounding.technique(method.grounding if method is not None else None)
    for number, (group, fields) in enumerate(slices):
        check()
        skipped_paths = set()
        if method is not None and method.evidence_policy == "schema":
            for path, _ in leaves(fields):
                policy = evidence_policy(schema.record_nodes, path)
                if policy != "quoted":
                    full_path = ("records", number, *path)
                    skipped_paths.add(full_path)
                    result.skipped.append({"path": list(full_path), "policy": policy})
                    result.issues.append(Issue("evidence_policy_skipped", f"{policy}: source verification not requested",
                                               number, full_path))
        groups = [c.passages for c in contexts] if identities is not None else [group]
        verification = dict(record=number, budget=budget, counter=counter,
            record_context=(identities[number]["label"] + "\n" + json.dumps(identities[number]["identity"],
                ensure_ascii=False)) if identities is not None else None,
            before_call=check, proofs=result.proofs)
        if method is not None and method.grounding_routing is not None:
            links, calls, issues, routes = verify_routed(contexts, fields, schema, chat,
                origins=origins[number], value_contexts=value_contexts[number],
                skip_paths=frozenset(skipped_paths), verifier=verifier, **verification)
            result.links += links
            result.calls += calls
            result.issues += issues
            result.routes += routes
            groups = []
        for group in groups:
            links, calls, issues = verifier(group, fields, schema, chat,
                skip_paths=frozenset(skipped_paths | ({link.path for link in result.links}
                    if method is not None and method.grounding_schedule == "unresolved" else set())), **verification)
            # Retain the first support in execution order; all calls/proofs remain auditable.
            known = {link.path for link in result.links}
            result.links += [link for link in links if link.path not in known]
            result.calls += calls
            result.issues += issues
    return result


def artifact(evidence: Evidence, request, chat: Router, *, started: str, clock: float, fields: Sequence[dict],
             document: dict, links: Sequence[Link], calls: Sequence[Call], issues: Sequence[Issue]) -> dict:
    """The artifact's common fields and its fingerprint.

    `fields` is each record's values: merged with the document and filename values in schema order, they are the
    records; a populated value without a link is ungrounded. `started` and `clock` were taken when the extraction
    began."""
    schema = request.schema_
    options = request.options
    records = [merge(values, document, evidence.source_name, schema) for values in fields]
    grounded = {link.path for link in links}
    ungrounded = [["records", number, *path] for number, values in enumerate(fields)
                  for path, _ in leaves(values) if ("records", number, *path) not in grounded]
    result = {
        "extraction_version": EXTRACTION_VERSION, "run_id": evidence.run_id, "generation": evidence.generation,
        "digest": evidence.digest, "strategy": options.strategy, "model": chat.model, "models": chat.models,
        "prompt_version": PROMPT_VERSION,
        "schema": schema.model_dump(by_alias=True, exclude_none=True), "options": options.dumped(),
        "started": started, "seconds": round(time.monotonic() - clock, 3),
        "complete": all(call.ok for call in calls) and not ungrounded and not issues,
        "records": records,
        "evidence": [{**asdict(link), "path": list(link.path), "bbox_pt": list(link.bbox_pt)} for link in links],
        "ungrounded": ungrounded,
        "unverified": [node.name for node in schema.document_nodes],
        "issues": [{**asdict(issue), "path": list(issue.path) if issue.path else None} for issue in issues],
        "calls": [asdict(call) for call in calls],
        "tokens": {"input": _total(call.input_tokens for call in calls),
                   "output": _total(call.output_tokens for call in calls)},
    }
    result["fingerprint"] = fingerprint(result, request, chat.models)
    return result


def _total(values) -> int | None:
    known = [value for value in values if value is not None]
    return sum(known) if known else None
