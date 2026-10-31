"""The forward migration keeps provider policy and exact saved source behind the restricted role."""
from uuid import uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb

from kei_exp.kie.extract.durable import CapturePlanner
from kei_exp.kie.extract.durable import NeedsCall
from kei_exp.workflows.coordination import CoordinationPool, Lease
from kei_exp.workflows.durable_extract import chat_for

pytestmark = pytest.mark.postgres


def test_codex_provider_capture_policy_and_immutable_input(database, coordination_database):
    extraction, project, selection, attempt, revision, source_revision = [str(uuid4()) for _ in range(6)]
    provider = {"key": "instruct", "adapterVersion": 1, "adapter": "codex-cli", "model": "test-model",
                "url": "codex://local", "timeout": 10, "maxTokens": 8192}
    with psycopg.connect(database, autocommit=True) as owner:
        assert owner.execute('SELECT extraction_runtime.valid_provider(%s)', [Jsonb(provider)]).fetchone()[0]
        assert not owner.execute('SELECT extraction_runtime.valid_provider(%s)',
            [Jsonb({**provider, 'url': 'http://unauthorized.test'})]).fetchone()[0]
        owner.execute('''INSERT INTO extraction_runtime.head
          (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",intent,"attemptId",fence,
           acknowledgement,"controlVersion","pendingResume","leaseEpoch",generation,"snapshotVersion",deleted)
          VALUES (%s,%s,%s,%s,'ARTICLE',%s,'RUN',%s,1,'QUEUED',0,false,0,1,0,false)''',
          (extraction, project, source_revision, Jsonb({'runId': 'fixture', 'generation': 'g1',
           'sourceRevisionId': source_revision}), selection, attempt))
        owner.execute('''INSERT INTO extraction_runtime.selection
          (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
          VALUES (%s,%s,1,%s,%s,%s,'{}','{}',%s)''',
          (selection, extraction, revision, 'a' * 64,
           Jsonb({'recordDescription': 'document', 'schemaNodes': [{'id': 'name', 'name': 'name', 'type': 'string'}]}), 'a' * 64))
        owner.execute('''INSERT INTO extraction_runtime.attempt
          (id,"extractionId","selectionId",fence,"workflowId") VALUES (%s,%s,%s,1,%s)''',
          (attempt, extraction, selection, 'test:' + attempt))
        owner.execute('INSERT INTO extraction_runtime."feedbackHead" (id,version) VALUES (%s,0)', [project])
    pool = CoordinationPool(coordination_database)
    try:
        with Lease(pool, extraction, attempt) as lease:
            configuration = {'models': {'fields': provider, 'reasoning': provider}, 'options': {'strategy': 'article'},
                             'planner': 1, 'protocols': {'calls': 1, 'source': 'document'}}
            lease.call('resolve_selection', configuration)
            lease.state['effective'] = configuration
            chat = chat_for(provider)
            lease.call('publish_plan', str(uuid4()), 'historical-coverage', {
                'plannerVersion': 1, 'selectionId': selection, 'sourceGeneration': 'g1', 'units': [], 'coverage': {}})
            planner = CapturePlanner(lease)
            schema = {'type': 'object', 'properties': {'name': {'type': 'string', 'x-free-type': 'string'}},
                      'required': ['name'], 'additionalProperties': False}
            with pytest.raises(NeedsCall):
                planner.complete(chat, stage='record', record=0, system='Extract the name.', user='Name: Local.',
                                 schema=schema, max_tokens=8192)
            (capture,) = planner.pending
            saved = lease.call('read_call', capture)['input']
            request = saved['request']
            assert request['provider'] == provider
            assert request['tokenizer']['input_counting'] == 'upper_bound'
            assert request['body']['httpRequest']['user'] == 'Name: Local.'
            assert request['body']['httpRequest']['schema'] == schema
            # Replaying a saved request stays idempotent; editing its source is refused by the database fence.
            assert lease.call('finalize_input', capture, request)['digest'] == saved['digest']
            request['body']['httpRequest']['user'] = 'Different source'
            with pytest.raises(psycopg.errors.InvalidParameterValue):
                lease.call('finalize_input', capture, request)
    finally:
        pool.close()
