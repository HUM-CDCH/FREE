"""Retained values are produced from validated stage objects, never debug files."""
from __future__ import annotations

from uuid import UUID

from kei_exp.kie.extract.durable import digest
from kei_exp.kie.extract.schema import Schema, conform


def record_identity(source_revision: str, scope) -> str:
    return digest(["record", source_revision, scope])


def saved_record(router, fields: dict, scope, *, record: int = 0, links=(), primary=()):
    if getattr(router,"runtime",None) is not None:
        router.runtime.saved_record(fields, scope, record=record, links=links, primary=primary)


def reuse_record(router, scope, *, record=0):
    if getattr(router,"runtime",None) is None:
        return None
    return router.runtime.reuse_record(scope,record=record)


def plan_records(router, stage, scopes):
    if getattr(router,"runtime",None) is not None:
        router.runtime.plan_records(stage,scopes)


def publish_values(lease, fields: dict, scope, *, record=0, links=(), complete=False, primary=()):
    selection = lease.state["selection"]
    raw = selection["schemaTree"]
    schema = Schema.model_validate(raw)
    produced = set(fields)
    fields = conform(fields, schema.nodes)
    source_revision = lease.state["source"].get("sourceRevisionId", lease.state["source"].get("artifactSha256"))
    record_id = record_identity(source_revision, scope)
    values = []
    for node in raw["schemaNodes"]:
        value = fields.get(node["name"])
        evidence = []
        for link in links:
            path = link.get("path", [])
            if path[:3] == ["records", record, node["name"]]:
                evidence.append({"anchorId": "a_" + link["segment"] + ("_" + link["cell"] if link.get("cell") else ""),
                                 "occurrenceIds": []})
        # Composite values need leaf-by-leaf accounting before being called
        # grounded. Partial stage values carry no inferred Evidence.
        grounded = bool(evidence) and node["type"] not in ("object", "array")
        values.append({"id": digest([record_id, node["id"]]), "recordId": record_id, "fieldId": node["id"],
                       "path": ["records", record, node["name"]], "selectionId": selection["id"],
                       "schemaRevisionId": selection["schemaRevisionId"], "node": node, "modelValue": value,
                       "evidence": evidence, "grounding": "grounded" if grounded else "ungrounded" if complete else "provisional",
                       "processing": "saved" if value is not None else "absent" if complete or node["name"] in produced else "unprocessed", "lineage": []})
    publication = digest([selection["id"], scope, values, complete, primary])
    identity = str(UUID(publication[:32], version=5))
    coverage = {"sourceGeneration": lease.state["source"]["generation"], "primaryScope": scope,
                "recordScope": raw.get("recordScope"), "processingComplete": complete,
                "denominator": None, "incomplete": not complete,
                "completedScopes": {digest(primary): {"scope": scope, "primary": list(primary)}} if primary else {}}
    return lease.call("publish_snapshot", identity, selection["id"], values, coverage)


def publish_final(lease, result):
    records = result["records"]
    # Record scopes were captured at the producer boundary. If a method cannot
    # prove a final record's lineage, retain it under a distinct historical
    # identity rather than guessing a mapping from its presentation ordinal.
    scopes = lease.state.get("recordScopes", {})
    for index, fields in enumerate(records):
        scope = scopes.get(str(index), scopes.get(index))
        if isinstance(scope,dict) and scope.get("historical") is True:
            continue
        if result["strategy"] == "article":
            scope = "document"
        if scope is None:
            raise ValueError("record has no canonical source scope")
        publish_values(lease, fields, scope, record=index, links=result.get("evidence", []), complete=True)
