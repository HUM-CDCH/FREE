"""Real-process test databases install the same protocol and restricted role as Studio startup."""
import psycopg
import pytest
import json
from uuid import UUID, uuid4
from psycopg.types.json import Jsonb

from kei_exp.workflows.coordination import CoordinationPool, _storable
from kei_exp.workflows.coordination import Lease
from kei_exp.kie.extract.durable import digest
from kei_exp.kie.extract.retained import publish_completion, publish_values

pytestmark = pytest.mark.postgres


@pytest.mark.parametrize("with_issues", [False, True])
def test_old_completion_replayed_by_new_code_keeps_values_and_versions_idempotently(database, coordination_database, with_issues):
    extraction, project, selection, attempt, revision, source_revision = [str(uuid4()) for _ in range(6)]
    node = {"id": "fees", "name": "fees", "type": "array", "itemType": "number"}
    issues = [{"code": "resolution_not_applied", "detail": json.dumps({"path": ["fees"], "reason": "invalid_list_reply"}),
               "record": 0, "path": ["records", 0, "fees"]}] if with_issues else []
    with psycopg.connect(database, autocommit=True) as owner:
        owner.execute('''INSERT INTO extraction_runtime.head
          (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",intent,"attemptId",fence,
           acknowledgement,"controlVersion","pendingResume","leaseEpoch",generation,"snapshotVersion",deleted)
          VALUES (%s,%s,%s,%s,'ARTICLE',%s,'RUN',%s,1,'QUEUED',0,false,0,1,0,false)''',
                      (extraction, project, source_revision,
                       Jsonb({"runId": "fixture", "generation": "g1", "sourceRevisionId": source_revision}), selection, attempt))
        owner.execute('''INSERT INTO extraction_runtime.selection
          (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
          VALUES (%s,%s,1,%s,%s,%s,'{}','{}',%s)''',
                      (selection, extraction, revision, "a" * 64,
                       Jsonb({"recordDescription": "document", "schemaNodes": [node]}), "a" * 64))
        owner.execute('''INSERT INTO extraction_runtime.attempt
          (id,"extractionId","selectionId",fence,"workflowId") VALUES (%s,%s,%s,1,%s)''',
                      (attempt, extraction, selection, "test:" + attempt))
        owner.execute('INSERT INTO extraction_runtime."feedbackHead" (id,version) VALUES (%s,0)', (project,))
    pool = CoordinationPool(coordination_database)
    try:
        lease = Lease(pool, extraction, attempt)
        record = publish_values(lease, {"fees": [10, 10]}, "document", complete=True, historical={},
                                metadata={"issues": issues, "seconds": 1.5})
        # Pre-#279 completion protocol: same proof and digest, no diagnostics even when the record has them.
        coverage = {"sourceGeneration": "g1", "finalizedAttempt": {
            "attemptId": attempt, "generation": 1, "selectionId": selection, "complete": True}}
        old_identity = str(UUID(digest(["finalized-attempt", coverage])[:32], version=5))
        old = lease.call("publish_snapshot", old_identity, selection, [], coverage)
        assert (record["version"], old["version"]) == (1, 2)
        assert old["values"] == record["values"] and old["values"][0]["modelValue"] == [10, 10]
        assert "diagnostics" not in old["coverage"]
        new = publish_completion(lease, True, issues)
        assert new["version"] == old["version"] + bool(issues)
        assert (new["id"] != old["id"]) is bool(issues)
        assert new["values"] == old["values"]
        assert new["coverage"]["finalizedAttempt"] == coverage["finalizedAttempt"]
        assert new["coverage"]["sourceGeneration"] == "g1"
        if issues:
            assert new["coverage"]["diagnostics"] == {"issues": issues}
        else:
            assert new == old
        assert publish_completion(lease, True, issues) == new
        assert publish_completion(lease, True, issues) == new
        # Fresh connection reads immutable old/new snapshots and the head after repeated replay.
        with psycopg.connect(database, autocommit=True) as owner:
            saved = owner.execute('SELECT to_jsonb(s) FROM extraction_runtime.snapshot s WHERE id=%s', (old["id"],)).fetchone()[0]
            assert saved == old
            assert owner.execute('SELECT "snapshotVersion" FROM extraction_runtime.head WHERE id=%s', (extraction,)).fetchone()[0] == new["version"]
            assert owner.execute('SELECT count(*) FROM extraction_runtime.snapshot WHERE "extractionId"=%s', (extraction,)).fetchone()[0] == new["version"]
        assert lease.call("read_latest_snapshot") == new
    finally:
        pool.close()


def test_real_worker_bootstrap_keeps_runtime_permissions_and_checks_protocol(database, coordination_database):
    pool = CoordinationPool(coordination_database)
    try:
        pool.ready()
        with psycopg.connect(coordination_database, autocommit=True) as worker:
            assert worker.execute("SELECT current_user").fetchone()[0].startswith("free_test_parsing_")
            for statement in (
                "SELECT count(*) FROM public.extraction",
                "SELECT count(*) FROM extraction_runtime.head",
                "SELECT extraction_runtime.content_hash('{}'::jsonb)",
            ):
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    worker.execute(statement)
            worker.execute("CREATE TABLE kei_dbos.permission_probe (id integer)")
        with psycopg.connect(database, autocommit=True) as owner:
            owner.execute("UPDATE extraction_runtime.protocol SET version = 2 WHERE id = 1")
        with pytest.raises(ValueError, match="incompatible Extraction coordination protocol"):
            pool.ready()
    finally:
        pool.close()


def test_nul_text_is_stored_as_replacement_character_by_capture_checkpoint_and_snapshot_routines(database, coordination_database):
    extraction, project, selection, attempt, revision, capture = [str(uuid4()) for _ in range(6)]
    node = {"id": "content", "name": "content", "type": "string"}
    text = "cm\x00 1; literal \\u0000; λ⁻¹"
    with psycopg.connect(database, autocommit=True) as owner:
        owner.execute('''INSERT INTO extraction_runtime.head
          (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",intent,"attemptId",fence,
           acknowledgement,"controlVersion","pendingResume","leaseEpoch",generation,"snapshotVersion",deleted)
          VALUES (%s,%s,%s,%s,'ARTICLE',%s,'RUN',%s,1,'QUEUED',0,false,0,1,0,false)''',
                      (extraction, project, str(uuid4()), Jsonb({"runId": "fixture", "generation": "g1"}), selection, attempt))
        owner.execute('''INSERT INTO extraction_runtime.selection
          (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
          VALUES (%s,%s,1,%s,%s,%s,'{}','{}',%s)''',
                      (selection, extraction, revision, "a" * 64,
                       Jsonb({"recordDescription": "document", "schemaNodes": [node]}), "a" * 64))
        owner.execute('''INSERT INTO extraction_runtime.attempt
          (id,"extractionId","selectionId",fence,"workflowId") VALUES (%s,%s,%s,1,%s)''',
                      (attempt, extraction, selection, "test:" + attempt))
        owner.execute('INSERT INTO extraction_runtime."feedbackHead" (id,version) VALUES (%s,0)', (project,))
    pool = CoordinationPool(coordination_database)
    try:
        state = pool.call("claim", extraction, attempt, pool.process)
        def invoke(name, *args): return pool.call(name, extraction, attempt, state["epoch"], *args)
        plan = invoke("publish_plan", str(uuid4()), "record",
                      {"plannerVersion": 1, "selectionId": selection, "sourceGeneration": "g1",
                       "units": [{"key": "record"}], "coverage": {}})
        invoke("capture_unit", capture, "record",
               {"stage": "record", "scope": "document", "ordinal": 0, "planDigest": plan["digest"], "role": "fields"})
        provider = {"key": "stub", "model": "stub", "adapter": "instruct", "adapterVersion": 1,
                    "url": "http://stub/v1/chat/completions", "timeout": 60, "maxTokens": 100}
        invoke("resolve_selection", {"models": {"fields": provider, "reasoning": provider}, "options": {},
                                     "planner": 1, "protocols": {"calls": 1, "source": "document"}})
        request = {"provider": provider, "composer": 1, "tokenizer": {"model": "stub"},
                   "budget": {"counted": 10, "context": 1000, "reserve": 100}, "examples": [], "omissions": [],
                   "body": {"stage": "record", "record": 0, "system": "instructions", "user": text,
                            "schema": {"type": "object"}, "max_tokens": 100, "max_whitespace": None,
                            "httpRequest": {"model": "stub", "max_tokens": 100,
                                            "messages": [{"role": "user", "content": text}]}}}
        with psycopg.connect(database, autocommit=True) as owner, pytest.raises(psycopg.errors.UntranslatableCharacter):
            owner.execute("SELECT %s::jsonb", (Jsonb(request),))
        frozen = invoke("finalize_input", capture, request)
        assert frozen["request"] == _storable(request)
        assert frozen["request"]["body"]["user"] == "cm\ufffd 1; literal \\u0000; λ⁻¹"
        assert invoke("finalize_input", capture, request) == frozen
        assert invoke("read_call", capture)["input"]["request"] == _storable(request)
        assert invoke("begin_call", capture)
        output = {"parsed": {"content": text}, "calls": [{"ok": True, "raw": text}]}
        assert invoke("commit_output", capture, frozen["digest"], output)["output"] == _storable(output)
        assert invoke("read_call", capture)["checkpoint"]["output"] == _storable(output)
        value = {"id": "value", "recordId": "document", "fieldId": "content", "path": ["records", 0, "content"],
                 "selectionId": selection, "schemaRevisionId": revision, "node": node, "modelValue": text,
                 "evidence": [{"anchorId": "a_fixture", "occurrenceIds": [], "producer": {"quote": text}}],
                 "grounding": "ungrounded", "processing": "saved", "lineage": []}
        snapshot = invoke("publish_snapshot", str(uuid4()), selection, [value], {"completedScopes": {}})
        assert snapshot["values"] == [_storable(value)]
        assert invoke("read_latest_snapshot")["values"] == [_storable(value)]
    finally:
        pool.close()
