"""Ground fixed record values: one policy/scheduling owner for serving and experiments."""
from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from kei_exp.kie.extract.contexts import Context
from kei_exp.kie.extract.evidence import Passage
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.routing import verify_routed
from kei_exp.kie.extract.schema import Schema, evidence_policy
from kei_exp.kie.extract.stages import Call, Issue, Link, leaves, verify


@dataclass
class Grounding:
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
                   origins: Sequence[Sequence[dict]] = ()) -> Grounding:
    """Keep input values fixed while evaluating support; hints never create evidence.

    Article supplies identities and complete source contexts. Generic Catalog uses
    the owned passages in each slice. Neither path extracts or reconciles values here.
    """
    result = Grounding()
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
        if method is not None and method.grounding == "off":
            groups = []
        verification = dict(record=number, budget=budget, counter=counter,
            record_context=(identities[number]["label"] + "\n" + json.dumps(identities[number]["identity"],
                ensure_ascii=False)) if identities is not None else None,
            before_call=check, quoted=method is not None and method.grounding == "quoted", proofs=result.proofs,
            span_ids=method is not None and method.grounding == "spans")
        if method is not None and method.grounding_routing is not None:
            links, calls, issues, routes = verify_routed(contexts, fields, schema, chat,
                origins=origins[number], value_contexts=value_contexts[number],
                skip_paths=frozenset(skipped_paths), **verification)
            result.links += links
            result.calls += calls
            result.issues += issues
            result.routes += routes
            groups = []
        for group in groups:
            links, calls, issues = verify(group, fields, schema, chat,
                skip_paths=frozenset(skipped_paths | ({link.path for link in result.links}
                    if method is not None and method.grounding_schedule == "unresolved" else set())), **verification)
            # Retain the first support in execution order; all calls/proofs remain auditable.
            known = {link.path for link in result.links}
            result.links += [link for link in links if link.path not in known]
            result.calls += calls
            result.issues += issues
    return result
