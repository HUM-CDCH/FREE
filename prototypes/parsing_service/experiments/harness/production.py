"""The service's own extraction artifacts (Article and Catalog, versions 1 to 3) as harness predictions.

This is how the production options `run.extract` already implements (bounded context, overlap, grounding, structured
rendering, the unified Catalog and its settings) are scored by the same evaluator as the research variants: run them
with the existing study tooling, then score the saved artifact against a case's gold here. Production records are
conformed to the schema, so an absent, an unread and a rejected field all read null; the artifact's `rejected` and
`proposed` lists and its completeness are what tell them apart, and this adapter uses them for exactly that, no more:
a null field is `omitted` when the artifact says processing was incomplete, `absent` otherwise.
"""
from __future__ import annotations

from typing import Any

from experiments.harness.data import Case

ABSENT_REASONS = {"type_mismatch", "no_quote"}           # the model gave a null value: the source does not give the field


def _links(artifact: dict, record: int, name: str, case: Case) -> list[dict]:
    texts = {p.id: p.text for p in case.evidence.passages}
    out = []
    for link in artifact.get("evidence", []):
        if link["path"][:3] != ["records", record, name]:
            continue
        spans = link.get("spans") or ([{"segment": link["segment"], "start": 0, "end": len(texts[link["segment"]])}]
                                      if link.get("segment") in texts else [])
        out.append({"quote": link.get("raw"), "ids": [], "method": "exact" if link.get("verbatim") else "passage", "approximate": False,
                    "score": None, "spans": spans, "alternatives": link.get("alternatives") or [], "ambiguous": bool(link.get("alternatives")),
                    "exists": bool(spans), "pages": [link["page"]] if link.get("page") is not None else [],
                    "bbox_pt": [link["bbox_pt"]] if link.get("bbox_pt") else None})
    return out


def adapt(artifact: dict, case: Case) -> dict[str, Any]:
    """A prediction for `case` from a production artifact. A value the artifact kept as a proposal (verification off or
    unclear) is a value row flagged `proposed`: score it with the evaluator's `excluded_flags` to see accepted-only and
    accepted-plus-proposed as separate views."""
    if case.evidence.generation != "inline" and artifact.get("digest") != case.evidence.digest:
        raise ValueError("the artifact was made from another source snapshot than this case's")
    unread = artifact.get("completeness", {}).get("processing") is False or artifact.get("processing", {}).get("complete") is False
    review = {"rejected": artifact.get("rejected", []), "proposed": artifact.get("proposed", [])}
    rows = []
    for i, record in enumerate(artifact["records"]):
        for node in case.schema.record_nodes:
            name = node.name
            value = record.get(name)
            entries = _links(artifact, i, name, case)
            found = [(kind, item) for kind, items in review.items() for item in items if item["path"][:3] == ["records", i, name]]
            row: dict[str, Any] = {"record": i, "field": name, "status": "value", "raw": value, "value": value, "normalized": False,
                                   "alternatives": [], "evidence": entries, "checks": None, "verdict": None, "flags": [], "signals": {},
                                   "votes": None, "contributors": []}
            if value is None:
                kind, item = found[0] if found else (None, None)
                if kind == "proposed":
                    row |= {"raw": item.get("value"), "value": item.get("value"), "flags": ["proposed"]}
                elif kind == "rejected" and item.get("reason") not in ABSENT_REASONS:
                    row |= {"status": "unsupported", "raw": item.get("value"), "value": None, "flags": [item.get("reason") or "rejected"]}
                else:
                    row |= {"status": "omitted" if unread else "absent", "value": None}
            rows.append(row)
    calls = artifact.get("calls", [])
    cost = {"calls": len(calls), "input_tokens": sum(c.get("input_tokens") or 0 for c in calls),
            "output_tokens": sum(c.get("output_tokens") or 0 for c in calls), "seconds": round(sum(c.get("seconds") or 0 for c in calls), 6),
            "failed": sum(not c.get("ok", True) for c in calls), "unknown_usage": sum(c.get("input_tokens") is None for c in calls)}
    return {"case": case.id, "records": artifact["records"], "fields": rows, "cost": {"fresh": cost, "replayed": dict.fromkeys(cost, 0)},
            "validity": {"total": len(calls), "valid": sum(bool(c.get("ok", True)) for c in calls)},
            "provenance": {"adapted_from": {"extraction_version": artifact.get("extraction_version"), "strategy": artifact.get("strategy")},
                           "replay_status": "unknown: production artifacts do not say which calls were replayed"}}
