"""Real-process test databases install the same protocol and restricted role as Studio startup."""
import psycopg
import pytest
from uuid import uuid4
from psycopg.types.json import Jsonb

from kei_exp.workflows.coordination import CoordinationPool

pytestmark = pytest.mark.postgres


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


def test_nul_text_survives_actual_capture_checkpoint_and_snapshot_routines(database, coordination_database):
    extraction, project, selection, attempt, revision, capture = [str(uuid4()) for _ in range(6)]
    node = {"id": "content", "name": "content", "type": "string"}
    text = 'cm\x00 1; literal \\u0000; λ⁻¹; ~free-jsonb-string-v1~"literal"'
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
        assert frozen["request"] == request
        assert invoke("finalize_input", capture, request) == frozen
        assert invoke("read_call", capture)["input"]["request"] == request
        assert invoke("begin_call", capture)
        output = {"parsed": {"content": text}, "calls": [{"ok": True, "raw": text}]}
        assert invoke("commit_output", capture, frozen["digest"], output)["output"] == output
        assert invoke("read_call", capture)["checkpoint"]["output"] == output
        value = {"id": "value", "recordId": "document", "fieldId": "content", "path": ["records", 0, "content"],
                 "selectionId": selection, "schemaRevisionId": revision, "node": node, "modelValue": text,
                 "evidence": [{"anchorId": "a_fixture", "occurrenceIds": [], "producer": {"quote": text}}],
                 "grounding": "ungrounded", "processing": "saved", "lineage": []}
        snapshot = invoke("publish_snapshot", str(uuid4()), selection, [value], {"completedScopes": {}})
        assert snapshot["values"] == [value]
        assert invoke("read_latest_snapshot")["values"] == [value]
    finally:
        pool.close()
