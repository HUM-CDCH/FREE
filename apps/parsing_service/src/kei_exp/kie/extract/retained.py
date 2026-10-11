"""Retained values are produced from validated stage objects, never debug files."""
from __future__ import annotations

from uuid import UUID

from kei_exp.kie.extract.durable import adapt_value, canonical, digest, field_meaning
from kei_exp.kie.extract.schema import Schema, conform


def record_identity(source_revision: str, scope) -> str:
    return digest(["record", source_revision, scope])


def saved_record(router, fields: dict, scope, *, record: int = 0, links=(), primary=(), disagreements=()):
    if getattr(router,"runtime",None) is not None:
        router.runtime.saved_record(fields, scope, record=record, links=links, primary=primary, disagreements=disagreements)


def reuse_record(router, scope, *, record=0):
    if getattr(router,"runtime",None) is None:
        return None
    return router.runtime.reuse_record(scope,record=record)


def discovering(router, found, lines):
    """Discovery's record starts so far and the lines of the window this thread asks for next, shown while the
    durable run reads (None once discovery is done). A view only: nothing is retained."""
    if getattr(router,"runtime",None) is not None:
        router.runtime.discovering(found, lines)


def plan_execution(router, stage, execution):
    if getattr(router,"runtime",None) is not None:
        router.runtime.plan_execution(stage,execution)


def plan_records(router, stage, scopes, *, partial=False):
    if getattr(router,"runtime",None) is not None:
        router.runtime.plan_records(stage,scopes,partial=partial)


def _walk(node, value, path):
    for child_id in path:
        if node is None or node["type"] != "object":
            return None, None
        node = next((child for child in node.get("children", []) if child["id"] == child_id), None)
        value = value.get(node["name"]) if node is not None and isinstance(value, dict) else None
    return node, value


def _retained(value_id, node, entry, origin):
    path = entry["path"][1:]
    leaf, _ = _walk(node, None, path)
    alternatives = []
    for alternative in entry["alternatives"]:
        value = alternative["value"]
        if type(value) is float and value.is_integer():
            value = int(value)
        alternatives.append({"id": digest([value_id, path, field_meaning(leaf), canonical(value)]), "value": value,
            "origins": [{**origin, **context} for context in alternative["contexts"]]})
    return {"path": path, "alternatives": alternatives}


def joined(*disagreements):
    """Canonical paths, IDs and origins make replay and adoption independent of reading order."""
    entries = {}
    for group in disagreements:
        for entry in group:
            path = canonical(entry["path"])
            saved = entries.setdefault(path, {"path": entry["path"], "alternatives": {}})
            for alternative in entry["alternatives"]:
                item = saved["alternatives"].setdefault(alternative["id"], {**alternative, "origins": {}})
                for origin in alternative["origins"]:
                    item["origins"][canonical(origin)] = origin
    return [{"path": entry["path"], "alternatives": [
        {**alternative, "origins": [origin for _, origin in sorted(alternative["origins"].items())]}
        for _, alternative in sorted(entry["alternatives"].items())]} for _, entry in sorted(entries.items())]


def merge_contribution(node, earlier, later, conflicts, held=None, path=()):
    if held and path in held:
        # shortcut: a new plain reading on adoption becomes an unreviewable historical proposal, upgrade when
        # reading contexts are available here and historicalProposals have their own review path.
        if later is not None and canonical(later) not in held[path]:
            conflicts.append({"path": list(path), "historical": None, "proposed": later})
        return None
    if later is None or later == earlier:
        return earlier
    if earlier is None:
        return later
    if node["type"] == "object":
        return {child["name"]: merge_contribution(child, earlier.get(child["name"]), later.get(child["name"]),
                    conflicts, held, (*path,child["id"])) for child in node.get("children", [])}
    if node["type"] == "array":
        return [*earlier, *later]
    conflicts.append({"path":list(path),"historical":earlier,"proposed":later})
    return earlier


def publish_values(lease, fields: dict, scope, *, record=0, links=(), complete=False, primary=(), field_ids=None, metadata=None,
                   historical=None, disagreements=()):
    selection = lease.state["selection"]
    raw = selection["schemaTree"]
    schema = Schema.model_validate(raw)
    produced = set(fields)
    fields = conform(fields, schema.nodes)
    source_revision = lease.state["source"]["sourceRevisionId"]
    record_id = record_identity(source_revision, scope)
    historical = historical if historical is not None else lease.call("historical_coverage")  # fixed per generation
    old_snapshot = historical.get("snapshot") or {}
    prior = {v["fieldId"]: v for v in old_snapshot.get("values", []) if v["recordId"] == record_id}
    reprocess = set(historical.get("manifest", {}).get("coverage", {}).get("reprocessValueIds", []))
    values, proposals = [], {}
    for node in raw["schemaNodes"]:
        if field_ids is not None and node["id"] not in field_ids:
            continue
        value = fields.get(node["name"])
        value_id = digest([record_id, node["id"]])
        origin = {"selectionId": selection["id"], "generation": lease.state["source"]["generation"]}
        disagreement = joined([_retained(value_id, node, entry, origin) for entry in disagreements
                               if entry["path"][0] == node["id"]])
        old = prior.get(node["id"])
        lineage = []
        if old and old["id"] not in reprocess and field_meaning(old["node"]) == field_meaning(node):
            # Empty remaining-source output never erases a saved contribution; a fresh disagreement is saved.
            if not disagreement and (value is None or (value == old["modelValue"] and not (isinstance(value,list) and scope == "document"))):
                continue
            conflicts = []
            if scope == "document":
                earlier = adapt_value(old["node"], node, old["modelValue"])
                carried = old.get("disagreement", [])
                held = {tuple(entry["path"]): {canonical(a["value"]) for a in entry["alternatives"]} for entry in carried}
                remaining = []
                for entry in disagreement:
                    _, previous = _walk(node, earlier, entry["path"])
                    if previous is None:
                        remaining.append(entry)
                    else:
                        conflicts.extend({"path": entry["path"], "historical": previous, "proposed": a["value"]}
                            for a in entry["alternatives"] if canonical(a["value"]) != canonical(previous))
                value = merge_contribution(node, earlier, value, conflicts, held)
                disagreement = joined([entry for entry in carried if _walk(node, value, entry["path"])[1] is None], remaining)
            if conflicts:
                proposals[old["id"]] = {"selectionId":selection["id"],"historicalSnapshotId":old_snapshot["id"],"conflicts":conflicts}
            ids = lambda entries: sorted(a["id"] for entry in entries for a in entry["alternatives"])
            # shortcut: unchanged carried disagreements do not record this selection's origins, upgrade when
            # origins can be appended without restamping the model version a decision reviewed.
            if value == old["modelValue"] and ids(disagreement) == ids(old.get("disagreement", [])):
                continue
            # shortcut: a growing disagreement republishes under this selection, so choices/rejections must be
            # made again (edits stay shown), upgrade when modelDigest can bind independently of input selection.
            lineage = [old_snapshot["id"] + ":" + old["id"]]
        evidence = []
        for link in links:
            path = link.get("path", [])
            if path[:3] == ["records", record, node["name"]]:
                evidence.append({"anchorId": "a_" + link["segment"] + ("_" + link["cell"] if link.get("cell") else ""),
                                 "occurrenceIds": [], "producer": link})
        # Composite values need leaf-by-leaf accounting before being called
        # grounded. A value published before the run completes stays
        # provisional even with its Evidence shown: adoption re-reads its record.
        grounded = bool(evidence) and node["type"] not in ("object", "array")
        values.append({"id": value_id, "recordId": record_id, "fieldId": node["id"],
                       "path": ["records", record, node["name"]], "selectionId": selection["id"],
                       "schemaRevisionId": selection["schemaRevisionId"], "node": node, "modelValue": value,
                       "evidence": evidence, "grounding": ("grounded" if grounded else "ungrounded") if complete else "provisional",
                       "processing": "saved" if value is not None or disagreement else "absent" if complete or node["name"] in produced else "unprocessed", "lineage": lineage,
                       **({"disagreement": disagreement} if disagreement else {})})
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
    # Replanning must republish byte-identical disagreements. Wall-clock diagnostics belong to the artifact,
    # not this saved cut's identity; plain publications retain their existing bytes.
    excluded = {"records", "started", "seconds"} if result.get("disagreements") else {"records"}
    metadata = {key: value for key, value in result.items() if key not in excluded}
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
        disagreements = ()
        if result["strategy"] == "article":
            scope, disagreements = "document", result.get("disagreements", ())
        if scope is None:
            raise ValueError("record has no canonical source scope")
        publish_values(lease, fields, scope, record=index, links=result.get("evidence", []), complete=True, field_ids={node["id"] for node in raw_nodes if node.get("valueSource") is None}, metadata=metadata, disagreements=disagreements)
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
    source=runtime.lease.state["source"]["sourceRevisionId"]
    identity=record_identity(source,"document-fields")
    historical=runtime.historical.get("snapshot") or {}
    values={v["fieldId"]:v for v in historical.get("values",[]) if v["recordId"]==identity and v["processing"] in ("saved","absent")
            and historical.get("coverage",{}).get("completedDocumentFields",{}).get(v["id"])}
    reprocess=set(runtime.historical.get("manifest",{}).get("coverage",{}).get("reprocessValueIds",[]))
    carried={node.name:adapt_value(values[node.id]["node"],node.model_dump(by_alias=True,exclude_none=True),values[node.id]["modelValue"]) for node in schema.document_nodes if node.id in values
        and values[node.id]["id"] not in reprocess and field_meaning(values[node.id]["node"])==field_meaning(node.model_dump(by_alias=True,exclude_none=True))}
    return schema.model_copy(update={"nodes":[node for node in schema.nodes if node.name not in carried]}),carried
