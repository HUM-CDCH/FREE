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


def merge_contribution(node, earlier, later, conflicts, path=()):
    if later is None or later == earlier:
        return earlier
    if earlier is None:
        return later
    if node["type"] == "object":
        return {child["name"]: merge_contribution(child, earlier.get(child["name"]), later.get(child["name"]),
                    conflicts, (*path,child["id"])) for child in node.get("children", [])}
    if node["type"] == "array":
        return [*earlier, *later]
    conflicts.append({"path":list(path),"historical":earlier,"proposed":later})
    return earlier


def publish_values(lease, fields: dict, scope, *, record=0, links=(), complete=False, primary=(), field_ids=None, metadata=None):
    selection = lease.state["selection"]
    raw = selection["schemaTree"]
    schema = Schema.model_validate(raw)
    produced = set(fields)
    fields = conform(fields, schema.nodes)
    source_revision = lease.state["source"].get("sourceRevisionId", lease.state["source"].get("artifactSha256"))
    record_id = record_identity(source_revision, scope)
    historical = lease.call("historical_coverage")
    old_snapshot = historical.get("snapshot") or {}
    prior = {v["fieldId"]: v for v in old_snapshot.get("values", []) if v["recordId"] == record_id}
    reprocess = set(historical.get("manifest", {}).get("coverage", {}).get("reprocessValueIds", []))
    values, proposals = [], {}
    for node in raw["schemaNodes"]:
        if field_ids is not None and node["id"] not in field_ids:
            continue
        value = fields.get(node["name"])
        old = prior.get(node["id"])
        lineage = []
        if old and old["id"] not in reprocess:
            # Empty remaining-source output never erases a saved contribution.
            # Identical carried values retain their original selection too.
            if value is None or (value == old["modelValue"] and not (isinstance(value,list) and scope == "document")):
                continue
            from kei_exp.kie.extract.durable import field_meaning, adapt_value
            if field_meaning(old["node"]) == field_meaning(node):
                conflicts = []
                if scope == "document":
                    value = merge_contribution(node,adapt_value(old["node"],node,old["modelValue"]),value,conflicts)
                if conflicts:
                    proposals[old["id"]] = {"selectionId":selection["id"],"historicalSnapshotId":old_snapshot["id"],"conflicts":conflicts}
                if value == old["modelValue"]:
                    continue
                lineage = [old_snapshot["id"] + ":" + old["id"]]
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
                       "processing": "saved" if value is not None else "absent" if complete or node["name"] in produced else "unprocessed", "lineage": lineage})
    publication = digest([selection["id"], scope, values, complete, primary, metadata, proposals])
    identity = str(UUID(publication[:32], version=5))
    coverage = {"sourceGeneration": lease.state["source"]["generation"], "primaryScope": scope,
                "recordScope": raw.get("recordScope"), "processingComplete": complete,
                "denominator": None, "incomplete": not complete,
                "completedScopes": {digest(primary): {"scope": scope, "primary": list(primary)}} if primary else {},
                "historicalProposals":proposals,
                "completedDocumentFields":{value["id"]:True for value in values} if complete and scope == "document-fields" else {}}
    if metadata is not None:
        coverage["diagnostics"] = metadata
    return lease.call("publish_snapshot", identity, selection["id"], values, coverage)


def processing_complete(result):
    return result.get("completeness", {}).get("processing",
        all(call.get("ok") or call.get("recovered") for call in result.get("calls", [])))


def publish_completion(lease, complete):
    # Only the final compiler publishes this proof, after all result writes.
    # It also represents successful empty results and carried historical work.
    selection = lease.state["selection"]["id"]
    coverage = {"sourceGeneration": lease.state["source"]["generation"],
        "finalizedAttempt": {"attemptId": lease.attempt, "generation": lease.state["generation"],
            "selectionId": selection, "complete": bool(complete)}}
    identity = str(UUID(digest(["finalized-attempt", coverage])[:32], version=5))
    return lease.call("publish_snapshot", identity, selection, [], coverage)


def publish_final(lease, result):
    records = result["records"]
    metadata = {key: value for key, value in result.items() if key != "records"}
    raw_nodes = lease.state["selection"]["schemaTree"]["schemaNodes"]
    document_ids = {node["id"] for node in raw_nodes if node.get("valueSource") is not None}
    if records and document_ids:
        publish_values(lease, records[0], "document-fields", complete=True, field_ids=document_ids, metadata=metadata)
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
        publish_values(lease, fields, scope, record=index, links=result.get("evidence", []), complete=True, field_ids={node["id"] for node in raw_nodes if node.get("valueSource") is None}, metadata=metadata)
    publish_completion(lease, processing_complete(result))


def saved_document(router, fields: dict, *, complete=False):
    runtime=getattr(router,"runtime",None)
    if runtime is None:
        return
    ids={node["id"] for node in runtime.selection["schemaTree"]["schemaNodes"] if node.get("valueSource") is not None}
    if ids:
        publish_values(runtime.lease, fields, "document-fields", complete=complete, field_ids=ids)


def document_inputs(router, schema):
    """Carry immutable completed document fields; call only for added/unfinished ones."""
    runtime=getattr(router,"runtime",None)
    if runtime is None:
        return schema, {}
    from kei_exp.kie.extract.durable import field_meaning, adapt_value
    source=runtime.lease.state["source"]["sourceRevisionId"]
    identity=record_identity(source,"document-fields")
    historical=runtime.historical.get("snapshot") or {}
    values={v["fieldId"]:v for v in historical.get("values",[]) if v["recordId"]==identity and v["processing"] in ("saved","absent")
            and historical.get("coverage",{}).get("completedDocumentFields",{}).get(v["id"])}
    reprocess=set(runtime.historical.get("manifest",{}).get("coverage",{}).get("reprocessValueIds",[]))
    carried={node.name:adapt_value(values[node.id]["node"],node.model_dump(by_alias=True,exclude_none=True),values[node.id]["modelValue"]) for node in schema.document_nodes if node.id in values
        and values[node.id]["id"] not in reprocess and field_meaning(values[node.id]["node"])==field_meaning(node.model_dump(by_alias=True,exclude_none=True))}
    return schema.model_copy(update={"nodes":[node for node in schema.nodes if node.name not in carried]}),carried
